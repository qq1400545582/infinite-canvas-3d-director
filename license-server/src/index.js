/**
 * 无限画布 · 账号与授权服务
 *
 * 启动：node src/index.js   （零依赖，Node >= 20）
 * 环境变量见 .env.example；不配置 LICENSE_ADMIN_PASSWORD 时会使用默认口令并在启动日志里警告。
 */
import "./env.js";
import { createServer } from "node:http";
import { handle, errorPayload } from "./api.js";
import { mailerConfigured, smtpSource } from "./mailer.js";
import { dbFile, load, saveNow } from "./store.js";

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";

/** 允许跨域来源：默认 *（前端可能来自 127.0.0.1:3000 的桌面壳或任意自建域名）。 */
function allowedOrigin(origin) {
    const raw = (process.env.LICENSE_ALLOWED_ORIGINS || "*").trim();
    if (raw === "*" || !raw) return "*";
    const list = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (!origin) return list[0] || "*";
    return list.includes(origin) ? origin : "";
}

function applyCors(req, res) {
    const origin = req.headers.origin;
    const allow = allowedOrigin(origin);
    if (!allow) return false;
    res.setHeader("access-control-allow-origin", allow === "*" ? "*" : allow);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization");
    res.setHeader("access-control-max-age", "86400");
    return true;
}

const server = createServer(async (req, res) => {
    const started = Date.now();
    if (!applyCors(req, res)) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: { code: "origin_denied", message: "来源不被允许" } }));
        return;
    }
    try {
        await handle(req, res);
    } catch (error) {
        const { status, body } = errorPayload(error);
        if (status >= 500) console.error("[license] 处理失败", req.method, req.url, error);
        if (!res.headersSent) {
            res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(body));
        } else {
            res.end();
        }
    } finally {
        if (process.env.LICENSE_LOG !== "0") {
            console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
        }
    }
});

load();
saveNow()
    .then(() => {
        server.listen(PORT, HOST, () => {
            const base = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
            const source = smtpSource();
            console.log(`\n  无限画布授权服务已启动  ${base}`);
            console.log(`  运营后台：${base}/admin`);
            console.log(`  数据文件：${dbFile}`);
            console.log(
                `  发信配置：${
                    mailerConfigured()
                        ? `已配置（来源：${source === "db" ? "后台设置" : "环境变量"}，可在 /admin 内修改）`
                        : "未配置（可在 /admin → 发信配置 里填写；本地调试也可用 LICENSE_DEV_ECHO_CODE=1）"
                }`,
            );
            if (!process.env.LICENSE_ADMIN_PASSWORD) {
                console.log("  ⚠ 未设置 LICENSE_ADMIN_PASSWORD，后台口令使用默认值 admin123，请尽快修改");
            }
            if (!process.env.LICENSE_SECRET) {
                console.log("  提示：令牌密钥已自动生成并保存在 data/secret.txt，可通过 LICENSE_SECRET 覆盖");
            }
            console.log("");
        });
    })
    .catch((error) => {
        console.error("初始化数据文件失败", error);
        process.exit(1);
    });

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        await saveNow().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
