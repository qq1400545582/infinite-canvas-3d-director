/**
 * 密码与令牌：全部基于 node:crypto，不引入依赖。
 * - 密码：scrypt（N=16384,r=8,p=1），存 salt$hash，校验用 timingSafeEqual
 * - 令牌：HMAC-SHA256 签名的紧凑格式 payload.signature（base64url），带过期时间与 scope
 */
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.js";

function loadSecret() {
    const fromEnv = (process.env.LICENSE_SECRET || "").trim();
    if (fromEnv) return fromEnv;
    // 未配置时自动生成并持久化到 data/secret.txt：重启后令牌不失效，也不会用默认弱密钥
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "secret.txt");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    const secret = randomBytes(32).toString("hex");
    writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
    return secret;
}

const SECRET = loadSecret();

export function newId(prefix = "") {
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    return prefix ? `${prefix}_${id}` : id;
}

/* ---------------- 密码 ---------------- */

export function hashPassword(plain) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(String(plain), salt, 64).toString("hex");
    return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
    if (typeof stored !== "string") return false;
    const [algo, salt, hash] = stored.split("$");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(String(plain), salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------------- 令牌 ---------------- */

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (str) => Buffer.from(str, "base64url");

export function signToken(payload, ttlSeconds) {
    const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
    const data = b64u(JSON.stringify(body));
    const sig = createHmac("sha256", SECRET).update(data).digest("base64url");
    return `${data}.${sig}`;
}

export function verifyToken(token) {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expect = createHmac("sha256", SECRET).update(data).digest("base64url");
    const a = unb64u(sig);
    const b = unb64u(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let payload;
    try {
        payload = JSON.parse(unb64u(data).toString("utf8"));
    } catch {
        return null;
    }
    if (!payload || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
}

/** 一次性验证码：6 位数字，排除易混字符。 */
export function newCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}
