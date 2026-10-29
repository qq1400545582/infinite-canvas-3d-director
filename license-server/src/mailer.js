/**
 * 最小 SMTP 客户端（node:net / node:tls 实现，不引入 nodemailer）。
 *
 * 支持两种常见接入方式：
 *   - 465 端口：连上即 TLS（QQ 邮箱、163、企业邮箱默认）
 *   - 587 / 25 端口：先明文 EHLO，再 STARTTLS 升级
 * 认证支持 AUTH LOGIN（主流邮箱）与 AUTH PLAIN 兜底。
 *
 * 只需要“发一封验证码邮件”，因此不处理附件、多部分正文、SMTP 扩展探测等复杂场景。
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { load } from "./store.js";

/** 排障开关：SMTP_DEBUG=1 时把每条命令与回复打到 stderr（远程部署时很有用）。 */
const debug = process.env.SMTP_DEBUG === "1" ? (...args) => console.error("[smtp]", ...args) : () => {};

/** 统一成内部结构：缺 host 直接视为未配置。 */
export function normaliseSmtp(raw) {
    const host = String(raw?.host || "").trim();
    if (!host) return null;
    const secureHint = raw.secure;
    const port = Number.parseInt(raw.port, 10) || (secureHint === false ? 587 : 465);
    const secure = secureHint === undefined || secureHint === null ? port === 465 : Boolean(secureHint);
    const user = String(raw.user || "").trim();
    const from = String(raw.from || "").trim() || user;
    return {
        host,
        port,
        secure,
        user,
        pass: String(raw.pass || ""),
        from,
        fromName: String(raw.fromName || "无限画布").trim(),
    };
}

/** 环境变量回退（老部署 / 未在后台填过发信配置时使用）。 */
function envConfig() {
    const host = (process.env.SMTP_HOST || "").trim();
    if (!host) return null;
    return normaliseSmtp({
        host,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE === undefined ? undefined : process.env.SMTP_SECURE !== "0",
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM,
        fromName: process.env.SMTP_FROM_NAME,
    });
}

/** 存储里的配置优先：后台改完即时生效，不用 redeploy。 */
function storedConfig() {
    try {
        return normaliseSmtp(load()?.settings?.smtp);
    } catch {
        return null;
    }
}

/** 当前生效的发信配置（可能为 null）。 */
export function smtpConfig() {
    return storedConfig() || envConfig();
}

/** 配置来源，后台用来提示「这条是从环境变量读的，改了会覆盖」。 */
export function smtpSource() {
    if (storedConfig()) return "db";
    return envConfig() ? "env" : "none";
}

export function mailerConfigured(cfg = smtpConfig()) {
    return Boolean(cfg && cfg.user && cfg.pass && cfg.from);
}

class SmtpSession {
    constructor(socket) {
        this.buffer = "";
        this.queue = [];
        this.pending = null;
        this.closed = false;
        // 监听器只在这里挂一次：早先构造里挂过一遍、attach 又挂一遍，
        // 同一段响应会被追加两次，导致后续命令全部读到错位的回复（QQ 会因此报
        // "need EHLO and AUTH first"）。
        this.attach(socket);
    }

    attach(socket) {
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            this.buffer += chunk;
            this.pump();
        });
        socket.on("error", (error) => this.fail(error));
        socket.on("close", () => this.fail(new Error("SMTP 连接已关闭")));
    }

    pump() {
        // 一段响应可能由多行组成（250-xxx 续行，最后一行 250 xxx），取第一组完整响应
        const lines = this.buffer.split("\r\n");
        for (let i = 0; i < lines.length - 1; i++) {
            if (/^\d{3} /.test(lines[i])) {
                const reply = lines.slice(0, i + 1).join("\r\n");
                this.buffer = lines.slice(i + 1).join("\r\n");
                if (this.pending) {
                    const { resolve } = this.pending;
                    this.pending = null;
                    resolve(reply);
                } else {
                    this.queue.push(reply);
                }
                return this.pump();
            }
        }
    }

    fail(error) {
        if (this.closed) return;
        this.closed = true;
        if (this.pending) {
            const { reject } = this.pending;
            this.pending = null;
            reject(error);
        }
    }

    read() {
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        if (this.closed) return Promise.reject(new Error("SMTP 连接已关闭"));
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject };
            setTimeout(() => {
                if (this.pending) {
                    this.pending = null;
                    reject(new Error("SMTP 响应超时"));
                }
            }, 20000).unref?.();
        });
    }

    async command(line, expect = [2, 3]) {
        debug(">>>", line.length > 40 ? `${line.slice(0, 10)}…(${line.length})` : line);
        this.socket.write(`${line}\r\n`);
        const reply = await this.read();
        const code = Number.parseInt(reply.slice(0, 3), 10);
        debug("<<<", reply.replace(/\r?\n/g, " | "));
        if (!expect.includes(Math.floor(code / 100))) {
            throw new Error(`SMTP ${line.split(" ")[0]} 失败：${reply.trim()}`);
        }
        return reply;
    }
}

function encodeHeader(value) {
    // 纯 ASCII 直接发，含中文走 RFC 2047 base64
    return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function dotStuff(text) {
    return text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

async function upgradeToTls(socket, host) {
    return new Promise((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: host }, () => resolve(secure));
        secure.once("error", reject);
        secure.setEncoding("utf8");
    });
}

/**
 * 发送纯文本邮件。失败抛异常，由调用方决定是否降级。
 *
 * `smtp` 可选：传了就用这份配置试发（后台"先测再存"），不传则用当前生效配置。
 */
export async function sendMail({ to, subject, text, smtp }) {
    const cfg = smtp ? normaliseSmtp(smtp) : smtpConfig();
    if (!mailerConfigured(cfg)) throw new Error("SMTP 未配置");

    const socket = cfg.secure
        ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : netConnect({ host: cfg.host, port: cfg.port });

    await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        setTimeout(() => reject(new Error("SMTP 连接超时")), 20000).unref?.();
    });

    let session = new SmtpSession(socket);
    try {
        await session.read(); // 220 欢迎语
        const ehloName = "infinite-canvas";
        let ehlo = await session.command(`EHLO ${ehloName}`, [2]);

        if (!cfg.secure && /\bSTARTTLS\b/i.test(ehlo)) {
            await session.command("STARTTLS", [2]);
            const secure = await upgradeToTls(socket, cfg.host);
            session = new SmtpSession(secure);
            ehlo = await session.command(`EHLO ${ehloName}`, [2]);
        }

        const supportsPlain = /\bAUTH\b[^\r\n]*\bPLAIN\b/i.test(ehlo);
        const supportsLogin = /\bAUTH\b.*\bLOGIN\b/i.test(ehlo) || /\bAUTH\b/i.test(ehlo);
        let authError = null;
        if (supportsLogin) {
            try {
                await session.command("AUTH LOGIN", [3]);
                await session.command(Buffer.from(cfg.user, "utf8").toString("base64"), [3]);
                await session.command(Buffer.from(cfg.pass, "utf8").toString("base64"), [2]);
            } catch (error) {
                // 有的服务端只认 PLAIN；LOGIN 失败后再试一次 PLAIN，两个都失败才报错
                authError = error;
            }
        }
        if ((authError || !supportsLogin) && supportsPlain) {
            const token = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`, "utf8").toString("base64");
            await session.command(`AUTH PLAIN ${token}`, [2]);
        } else if (authError) {
            throw authError;
        }

        await session.command(`MAIL FROM:<${cfg.from}>`, [2]);
        await session.command(`RCPT TO:<${to}>`, [2, 3]);
        await session.command("DATA", [3]);

        const stamp = new Date().toUTCString();
        const message = [
            `From: ${encodeHeader(cfg.fromName)} <${cfg.from}>`,
            `To: <${to}>`,
            `Subject: ${encodeHeader(subject)}`,
            `Date: ${stamp}`,
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
        ].join("\r\n");
        // dot-stuff 只能作用于正文：消息结束符那行 "." 必须原样发出，
        // 否则服务端永远等不到 <CRLF>.<CRLF>，连接会一直挂着直到超时。
        session.socket.write(`${dotStuff(message)}\r\n.\r\n`);
        debug("<<< (data 已发出)");
        const reply = await session.read();
        if (!/^2\d\d/.test(reply)) throw new Error(`SMTP DATA 被拒绝：${reply.trim()}`);
        await session.command("QUIT", [2]).catch(() => {});
        socket.destroy();
    } catch (error) {
        socket.destroy();
        throw error;
    }
}
