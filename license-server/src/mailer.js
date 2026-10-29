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

function config() {
    const host = (process.env.SMTP_HOST || "").trim();
    if (!host) return null;
    const port = Number.parseInt(process.env.SMTP_PORT || "", 10) || (process.env.SMTP_SECURE === "0" ? 587 : 465);
    return {
        host,
        port,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== "0" : port === 465,
        user: (process.env.SMTP_USER || "").trim(),
        pass: process.env.SMTP_PASS || "",
        from: (process.env.SMTP_FROM || process.env.SMTP_USER || "").trim(),
        fromName: (process.env.SMTP_FROM_NAME || "无限画布").trim(),
    };
}

export function mailerConfigured() {
    const cfg = config();
    return Boolean(cfg && cfg.user && cfg.pass && cfg.from);
}

class SmtpSession {
    constructor(socket) {
        this.socket = socket;
        this.buffer = "";
        this.queue = [];
        this.pending = null;
        this.closed = false;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            this.buffer += chunk;
            this.pump();
        });
        socket.on("error", (error) => this.fail(error));
        socket.on("close", () => this.fail(new Error("SMTP 连接已关闭")));
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
        this.socket.write(`${line}\r\n`);
        const reply = await this.read();
        const code = Number.parseInt(reply.slice(0, 3), 10);
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
 */
export async function sendMail({ to, subject, text }) {
    const cfg = config();
    if (!mailerConfigured()) throw new Error("SMTP 未配置");

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
        const supportsLogin = /\bAUTH\b[^\r\n]*\bLOGIN\b/i.test(ehlo) || /\bAUTH\b[^\r\n]*\r?\n/i.test(ehlo);
        if (supportsLogin) {
            await session.command("AUTH LOGIN", [3]);
            await session.command(Buffer.from(cfg.user, "utf8").toString("base64"), [3]);
            await session.command(Buffer.from(cfg.pass, "utf8").toString("base64"), [2]);
        } else if (supportsPlain) {
            const token = Buffer.from(`\u0000${cfg.user}\u0000${cfg.pass}`, "utf8").toString("base64");
            await session.command(`AUTH PLAIN ${token}`, [2]);
        }

        await session.command(`MAIL FROM:<${cfg.from}>`, [2]);
        await session.command(`RCPT TO:<${to}>`, [2, 3]);
        await session.command("DATA", [3]);

        const stamp = new Date().toUTCString();
        const body = [
            `From: ${encodeHeader(cfg.fromName)} <${cfg.from}>`,
            `To: <${to}>`,
            `Subject: ${encodeHeader(subject)}`,
            `Date: ${stamp}`,
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="UTF-8"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
            "",
            ".",
        ].join("\r\n");
        session.socket.write(`${dotStuff(body)}\r\n`);
        const reply = await session.read();
        if (!/^2\d\d/.test(reply)) throw new Error(`SMTP DATA 被拒绝：${reply.trim()}`);
        await session.command("QUIT", [2]).catch(() => {});
        socket.destroy();
    } catch (error) {
        socket.destroy();
        throw error;
    }
}
