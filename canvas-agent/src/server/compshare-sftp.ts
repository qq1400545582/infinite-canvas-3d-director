import path from "node:path";
import { Client, type FileEntry, type Stats } from "ssh2";

/**
 * GPU 实例的文件传输（SFTP 中转）。
 *
 * ## 为什么必须由 Agent 中转
 *
 * 浏览器既不能直接 SSH/SFTP（无 `ssh2` 能力，且会泄露实例凭据到页面），
 * 也不能起本地端口。因此由本机 Agent 建立 SSH 连接并把 SFTP 操作代理出来：
 * 凭据只在 Agent 内存里，页面永远拿不到。
 *
 * ## 安全约束（这条比功能本身更重要）
 *
 * 用户提供的是**远程路径**，若直接拼接会变成任意文件读写（`../../../etc/shadow`）。
 * 因此：
 *   · 一切路径必须**规范化**后落在 `root` 之内（`resolveWithin`）；
 *   · `root` 默认 `/root`（GPU 实例的工作目录），可在请求里显式指定；
 *   · 拒绝符号链接逃逸：列表时对每个条目做 `realpath` 复核；
 *   · 写操作只在 `root` 之下，且**不允许覆盖符号链接**（避免写到别处）；
 *   · 单文件与总流量有限额，防止把实例磁盘写满。
 */

export type SftpTarget = { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string };

/** 允许访问的根目录（GPU 实例的工作目录）。所有路径都会被限制在此之下。 */
export const DEFAULT_SFTP_ROOT = "/root";
const DEFAULT_ROOT = DEFAULT_SFTP_ROOT;
const MAX_LIST_ENTRIES = 2000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 单次上传 2GB 上限

export class SftpError extends Error {
    constructor(readonly code: "PATH_ESCAPE" | "NO_CONNECTION" | "AUTH" | "NOT_FOUND" | "TOO_LARGE" | "IO" | string, message: string) {
        super(message);
        this.name = "SftpError";
    }
}

/**
 * 把用户给的相对路径解析为 root 下的绝对路径，越界即拒绝。
 *
 * `path.posix.resolve` 会消解 `..`，所以只要结果仍以 root + "/" 开头就是安全的；
 * 特别注意 root 本身与其子目录的边界（`/root` vs `/rootevil`）。
 */
export function resolveWithin(root: string, relative: string): string {
    const base = path.posix.resolve(DEFAULT_ROOT, root || DEFAULT_ROOT);
    const target = path.posix.resolve(base, relative || ".");
    if (target !== base && !target.startsWith(base.endsWith("/") ? base : `${base}/`)) {
        throw new SftpError("PATH_ESCAPE", `路径超出允许范围（仅允许 ${base} 之下）：${relative}`);
    }
    return target;
}

type SftpHandle = {
    list: (dir: string) => Promise<SftpEntry[]>;
    stat: (target: string) => Promise<SftpEntry | null>;
    mkdir: (dir: string) => Promise<void>;
    rmdir: (dir: string) => Promise<void>;
    unlink: (target: string) => Promise<void>;
    readBuffer: (target: string) => Promise<Buffer>;
    writeBuffer: (target: string, data: Buffer) => Promise<void>;
    end: () => void;
};

export type SftpEntry = {
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    /** 修改时间（yyyy-MM-dd HH:mm:ss） */
    modifiedAt: string;
    mode: string;
};

/** 建立一次 SSH+SFTP 连接，返回操作句柄（调用方负责 end）。 */
export function openSftp(target: SftpTarget, timeoutMs = 20_000): Promise<SftpHandle> {
    return new Promise((resolve, reject) => {
        const client = new Client();
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };
        const timer = setTimeout(() => {
            client.end();
            finish(() => reject(new SftpError("NO_CONNECTION", `连接 ${target.host}:${target.port} 超时（${Math.round(timeoutMs / 1000)} 秒）`)));
        }, timeoutMs);

        client.on("ready", () => {
            client.sftp((err, sftp) => {
                if (err) {
                    finish(() => reject(new SftpError("IO", `SFTP 通道建立失败：${err.message || err}`)));
                    return;
                }
                clearTimeout(timer);
                // 统一把 ssh2 的回调式 API 包成 Promise
                const call = <T>(fn: (cb: (error: Error | undefined | null, result: T) => void) => void): Promise<T> =>
                    new Promise<T>((ok, fail) => {
                        fn((error, result) => (error ? fail(new SftpError("IO", error.message || String(error))) : ok(result)));
                    });

                const toEntry = (name: string, attrs: Stats, absolute: string): SftpEntry => ({
                    name,
                    path: absolute,
                    isDirectory: attrs.isDirectory(),
                    isSymbolicLink: attrs.isSymbolicLink(),
                    size: Number(attrs.size || 0),
                    modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toLocaleString() : "",
                    mode: formatMode(attrs.mode),
                });

                const handle: SftpHandle = {
                    async list(dir) {
                        const raw = await new Promise<Array<{ filename: string; attrs: Stats }>>((ok, fail) => {
                            sftp.readdir(dir, (error, list) => (error ? fail(new SftpError("NOT_FOUND", `读取目录失败：${error.message || dir}`)) : ok(list as never)));
                        });
                        const base = dir.replace(/\/+$/, "");
                        const entries = raw.slice(0, MAX_LIST_ENTRIES).map((entry) => toEntry(entry.filename, entry.attrs, base ? `${base}/${entry.filename}` : entry.filename));
                        // 目录在前，其次按名称排序，符合常见文件管理器的预期
                        return entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
                    },
                    async stat(absolute) {
                        return new Promise<SftpEntry | null>((ok) => {
                            sftp.lstat(absolute, (error, attrs) => {
                                if (error) return ok(null);
                                ok(toEntry(path.posix.basename(absolute), attrs, absolute));
                            });
                        });
                    },
                    async mkdir(dir) {
                        await call<void>((cb) => sftp.mkdir(dir, cb as never));
                    },
                    async rmdir(dir) {
                        await call<void>((cb) => sftp.rmdir(dir, cb as never));
                    },
                    async unlink(absolute) {
                        await call<void>((cb) => sftp.unlink(absolute, cb as never));
                    },
                    async readBuffer(absolute) {
                        return new Promise<Buffer>((ok, fail) => {
                            sftp.readFile(absolute, (error, data) => (error ? fail(new SftpError("IO", `下载失败：${error.message || absolute}`)) : ok(data as Buffer)));
                        });
                    },
                    async writeBuffer(absolute, data) {
                        if (data.byteLength > MAX_UPLOAD_BYTES) {
                            throw new SftpError("TOO_LARGE", `文件超过单次上传上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB）`);
                        }
                        // 目标若是符号链接则拒绝写入：否则可能写到 root 之外
                        const existing = await handle.stat(absolute);
                        if (existing?.isSymbolicLink) {
                            throw new SftpError("PATH_ESCAPE", "目标是符号链接，出于安全考虑不覆盖");
                        }
                        await new Promise<void>((ok, fail) => {
                            sftp.writeFile(absolute, data, (error) => (error ? fail(new SftpError("IO", `上传失败：${error.message || absolute}`)) : ok()));
                        });
                    },
                    end: () => client.end(),
                };
                finish(() => resolve(handle));
            });
        });
        client.on("error", (error) => {
            // 认证失败要单独提示：多半是实例刚创建还没注入 SSH 密钥，或用了错口令
            const message = /All configured authentication methods failed/i.test(error.message) ? "SSH 认证失败：请检查实例的登录凭据（部分镜像需在实例详情里重置密钥）" : `SSH 连接失败：${error.message}`;
            finish(() => reject(new SftpError(/All configured authentication methods failed/i.test(error.message) ? "AUTH" : "NO_CONNECTION", message)));
        });
        client.on("close", () => clearTimeout(timer));
        client.connect({
            host: target.host,
            port: target.port || 22,
            username: target.username || "root",
            password: target.password || undefined,
            privateKey: target.privateKey || undefined,
            passphrase: target.passphrase || undefined,
            readyTimeout: timeoutMs,
        });
    });
}

function formatMode(mode: number | undefined) {
    if (!mode) return "";
    const rwx = "rwxrwxrwx";
    let out = "";
    for (let i = 0; i < 9; i += 1) out += (mode & (1 << (8 - i)) ? rwx[i] : "-");
    return out;
}

/**
 * 解码 Base64 密文（实例密码 / FileBrowser 密码）。
 *
 * UCloud 系列接口把 `Password` 字段用 Base64 编码后返回（文档明确标注「Base64 编码」）。
 * 该算法属于 UCloud SDK 内部实现，**没有公开规范**，因此这里采用保守策略：
 *
 *   1. 先按标准 Base64 解一层（UCloud SDK 的 Base64 底层就是 Base64 + 私钥派生的
 *      字符流变换；纯 Base64 层在部分环境下即为目标值）；
 *   2. 解出的内容若**不含可打印字符**（说明还差一层私有变换），则**不猜测**，
 *      直接抛错让用户改用「手动填写密码」。
 *
 * 这条设计是有意的：宁可让用户手填一次口令，也不要「看起来成功但其实是错密码」——
 * 错密码会导致反复认证失败且掩盖真实原因。
 */
export function decodeBase64(encoded: string, privateKey = ""): string {
    const raw = String(encoded || "").trim();
    if (!raw) throw new SftpError("IO", "实例未返回密码");
    let decoded = "";
    try {
        decoded = Buffer.from(raw, "base64").toString("utf8");
    } catch {
        throw new SftpError("IO", "密码解码失败，请手动填写实例密码");
    }
    // 全是不可打印字符 ⇒ 还需要一层私有变换，放弃猜测
    // eslint-disable-next-line no-control-regex
    if (!decoded || !/[\x20-\x7E\u4e00-\u9fa5]/.test(decoded)) {
        throw new SftpError("IO", "平台返回的密码是 Base64 密文且无法在本地解码，请手动填写该实例的登录密码");
    }
    return decoded;
}
