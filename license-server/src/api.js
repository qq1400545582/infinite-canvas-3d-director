/**
 * HTTP API：账号（邮箱验证码注册 / 登录）、授权状态、易支付下单与异步通知、运营后台。
 *
 * 约定：所有响应为 JSON {ok:true,data} 或 {ok:false,error:{code,message}}；
 * 支付异步通知例外——易支付要求返回纯文本 success，否则会持续重推。
 */
import { randomBytes } from "node:crypto";
import { epaySign, buildSubmitParams, verifyNotify, sameMoney } from "./epay.js";
import { mailerConfigured, sendMail } from "./mailer.js";
import { hashPassword, newCode, newId, signToken, verifyPassword, verifyToken } from "./security.js";
import { dbFile, load, save, saveNow } from "./store.js";

const USER_TOKEN_TTL = 60 * 60 * 24 * 7; // 7 天免登录
const ADMIN_TOKEN_TTL = 60 * 60 * 12; // 后台 12 小时
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;

const devEchoCode = process.env.LICENSE_DEV_ECHO_CODE === "1";

/* ---------------- 基础工具 ---------------- */

const nowISO = () => new Date().toISOString();

function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
}

const ok = (res, data = {}) => json(res, 200, { ok: true, data });
const fail = (res, status, code, message, extra) => json(res, status, { ok: false, error: { code, message, ...extra } });

class HttpError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new HttpError(413, "payload_too_large", "请求体过大"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) return resolve({});
            const type = req.headers["content-type"] || "";
            try {
                if (type.includes("application/x-www-form-urlencoded")) {
                    resolve(Object.fromEntries(new URLSearchParams(raw)));
                } else if (type.includes("application/json")) {
                    resolve(JSON.parse(raw));
                } else {
                    // 兼容易支付以 query 形式 POST 通知的情况
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        resolve(Object.fromEntries(new URLSearchParams(raw)));
                    }
                }
            } catch {
                reject(new HttpError(400, "bad_json", "请求体不是合法的 JSON"));
            }
        });
        req.on("error", reject);
    });
}

function bearer(req) {
    const header = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : "";
}

function clientIp(req) {
    const forwarded = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
    return forwarded || req.socket?.remoteAddress || "";
}

/** 极简限流：滑动窗口，内存态即可（单实例部署）。 */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return false;
    list.push(now);
    buckets.set(key, list);
    if (buckets.size > 5000) buckets.clear();
    return true;
}

/* ---------------- 用户与授权状态 ---------------- */

export function userState(user, settings) {
    if (!user) return { state: "unknown" };
    if (user.status === "disabled") return { state: "disabled" };
    if (!settings.paywallEnabled) return { state: "active", until: null, free: true };
    const now = Date.now();
    const paidUntil = user.paidUntil ? new Date(user.paidUntil).getTime() : 0;
    if (paidUntil > now) return { state: "active", until: user.paidUntil };
    const trialEnd = user.trialEndsAt ? new Date(user.trialEndsAt).getTime() : 0;
    if (trialEnd > now) return { state: "trial", until: user.trialEndsAt };
    return { state: "expired", until: user.trialEndsAt || null };
}

function publicUser(user, settings) {
    const state = userState(user, settings);
    return {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        trialEndsAt: user.trialEndsAt,
        paidUntil: user.paidUntil || null,
        status: user.status,
        license: state,
    };
}

function requireUser(req) {
    const payload = verifyToken(bearer(req));
    if (!payload || payload.scope !== "user") throw new HttpError(401, "unauthorized", "登录状态已失效，请重新登录");
    const db = load();
    const user = db.users.find((item) => item.id === payload.uid);
    if (!user) throw new HttpError(401, "unauthorized", "账号不存在");
    if (user.status === "disabled") throw new HttpError(403, "disabled", "账号已被禁用，请联系管理员");
    return user;
}

function requireAdmin(req) {
    const payload = verifyToken(bearer(req));
    if (!payload || payload.scope !== "admin") throw new HttpError(401, "admin_unauthorized", "后台登录已失效");
    return payload;
}

/* ---------------- 邮箱校验 ---------------- */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function normaliseEmail(input) {
    const email = String(input || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email", "邮箱格式不正确");
    return email;
}

function assertDomainAllowed(email, settings) {
    const domain = email.split("@")[1];
    const list = (settings.emailDomains || []).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
    if (list.length === 0) return;
    const hit = list.some((item) => domain === item || domain.endsWith(`.${item}`));
    if (!hit) {
        throw new HttpError(400, "email_domain_not_allowed", `暂不支持 ${domain} 邮箱，请使用 ${list.slice(0, 4).join(" / ")} 等常见邮箱`, {
            allowedDomains: list,
        });
    }
}

/** 验证码是否必需：管理员开启且服务端确实能发信（或开发模式回显）。 */
function codeRequired(settings) {
    return Boolean(settings.requireEmailCode) && (mailerConfigured() || devEchoCode);
}

/* ---------------- 站点地址 ---------------- */

function publicBase(req) {
    const configured = (process.env.LICENSE_PUBLIC_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const proto = (req.headers["x-forwarded-proto"] || "http").toString().split(",")[0];
    const host = req.headers.host || `127.0.0.1:${process.env.PORT || 8787}`;
    return `${proto}://${host}`;
}

function siteUrl(req, settings) {
    const configured = (settings.siteUrl || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    return publicBase(req);
}

/* ---------------- 公开接口 ---------------- */

function settingsView(settings) {
    return {
        paywallEnabled: Boolean(settings.paywallEnabled),
        trialDays: Number(settings.trialDays) || 0,
        emailDomains: settings.emailDomains || [],
        requireEmailCode: codeRequired(settings),
        notice: settings.notice || "",
        siteUrl: settings.siteUrl || "",
        supportEmail: (settings.epay && settings.epay.supportEmail) || "",
    };
}

function plansView(plans) {
    return plans
        .filter((plan) => plan.active)
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .map((plan) => ({
            id: plan.id,
            name: plan.name,
            days: plan.days,
            price: String(plan.price),
            originalPrice: plan.originalPrice ? String(plan.originalPrice) : "",
            desc: plan.desc || "",
            badge: plan.badge || "",
        }));
}

/* ---------------- 邮箱验证码 ---------------- */

async function sendCode(req, res) {
    const body = await readBody(req);
    const db = load();
    const settings = db.settings;
    const email = normaliseEmail(body.email);
    assertDomainAllowed(email, settings);

    const ip = clientIp(req);
    if (!rateLimit(`code:email:${email}`, 1, CODE_RESEND_MS)) throw new HttpError(429, "code_too_frequent", "验证码发送过于频繁，请 1 分钟后再试");
    if (!rateLimit(`code:ip:${ip}`, 20, 60 * 60 * 1000)) throw new HttpError(429, "code_ip_limited", "发送次数过多，请稍后再试");

    const existing = db.users.find((user) => user.email === email);
    if (existing) throw new HttpError(409, "email_registered", "该邮箱已注册，请直接登录");

    const code = newCode();
    db.codes = db.codes.filter((item) => item.email !== email);
    db.codes.push({ email, code, createdAt: nowISO(), expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(), tries: 0 });
    saveNow();

    if (!mailerConfigured() && !devEchoCode) {
        throw new HttpError(503, "smtp_not_configured", "服务端尚未配置发信邮箱（SMTP），请联系管理员");
    }

    if (mailerConfigured()) {
        const minutes = Math.round(CODE_TTL_MS / 60000);
        await sendMail({
            to: email,
            subject: "【无限画布】注册验证码",
            text: `你的注册验证码是 ${code}，${minutes} 分钟内有效。\n\n如果不是你本人操作，请忽略本邮件。`,
        });
    }
    if (devEchoCode) console.log(`[license] dev code for ${email}: ${code}`);

    ok(res, { sent: true, ...(devEchoCode ? { devCode: code } : {}) });
}

/* ---------------- 注册 / 登录 ---------------- */

async function register(req, res) {
    const body = await readBody(req);
    const db = load();
    const settings = db.settings;
    const email = normaliseEmail(body.email);
    assertDomainAllowed(email, settings);

    const ip = clientIp(req);
    if (!rateLimit(`register:ip:${ip}`, 10, 60 * 60 * 1000)) throw new HttpError(429, "register_limited", "注册过于频繁，请稍后再试");
    if (db.users.some((user) => user.email === email)) throw new HttpError(409, "email_registered", "该邮箱已注册，请直接登录");

    const password = String(body.password || "");
    if (password.length < 8) throw new HttpError(400, "weak_password", "密码至少 8 位");
    if (password.length > 128) throw new HttpError(400, "weak_password", "密码过长");

    if (codeRequired(settings)) {
        const record = db.codes.find((item) => item.email === email);
        if (!record) throw new HttpError(400, "code_required", "请先获取邮箱验证码");
        if (new Date(record.expiresAt).getTime() < Date.now()) throw new HttpError(400, "code_expired", "验证码已过期，请重新获取");
        if (record.tries >= 5) throw new HttpError(429, "code_too_many_tries", "验证码错误次数过多，请重新获取");
        if (String(body.code || "").trim() !== record.code) {
            record.tries += 1;
            saveNow();
            throw new HttpError(400, "code_invalid", "验证码不正确");
        }
    }

    const trialDays = Math.max(0, Number(settings.trialDays) || 0);
    const user = {
        id: newId("u"),
        email,
        passwordHash: hashPassword(password),
        status: "normal",
        createdAt: nowISO(),
        trialEndsAt: new Date(Date.now() + trialDays * 86400000).toISOString(),
        paidUntil: null,
        lastLoginAt: nowISO(),
        note: "",
        registerIp: ip,
    };
    db.users.push(user);
    db.codes = db.codes.filter((item) => item.email !== email);
    saveNow();

    const token = signToken({ uid: user.id, scope: "user" }, USER_TOKEN_TTL);
    ok(res, { token, user: publicUser(user, settings) });
}

async function login(req, res) {
    const body = await readBody(req);
    const db = load();
    const settings = db.settings;
    const email = normaliseEmail(body.email);
    const ip = clientIp(req);
    if (!rateLimit(`login:ip:${ip}`, 30, 10 * 60 * 1000)) throw new HttpError(429, "login_limited", "登录尝试过于频繁，请稍后再试");

    const user = db.users.find((item) => item.email === email);
    if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
        throw new HttpError(401, "bad_credentials", "邮箱或密码不正确");
    }
    if (user.status === "disabled") throw new HttpError(403, "disabled", "账号已被禁用，请联系管理员");

    user.lastLoginAt = nowISO();
    saveNow();
    const token = signToken({ uid: user.id, scope: "user" }, USER_TOKEN_TTL);
    ok(res, { token, user: publicUser(user, settings) });
}

function me(req, res) {
    const db = load();
    const user = requireUser(req);
    ok(res, { user: publicUser(user, db.settings), settings: settingsView(db.settings) });
}

/* ---------------- 易支付 ---------------- */

async function createOrder(req, res) {
    const db = load();
    const settings = db.settings;
    const user = requireUser(req);
    const body = await readBody(req);
    const plan = db.plans.find((item) => item.id === body.planId && item.active);
    if (!plan) throw new HttpError(404, "plan_not_found", "套餐不存在或已下架");

    const epay = settings.epay || {};
    if (!epay.pid || !epay.key) {
        throw new HttpError(503, "epay_not_configured", "支付通道尚未配置商户号，请联系管理员");
    }

    const outTradeNo = `IC${Date.now()}${randomBytes(2).toString("hex").toUpperCase()}`;
    const order = {
        id: newId("o"),
        outTradeNo,
        userId: user.id,
        email: user.email,
        planId: plan.id,
        planName: plan.name,
        days: plan.days,
        money: String(plan.price),
        status: "pending",
        createdAt: nowISO(),
        paidAt: null,
        tradeNo: "",
        payType: epay.type || "alipay",
        source: "epay",
    };
    db.orders.push(order);
    saveNow();

    const base = publicBase(req);
    const { payUrl, params } = buildSubmitParams({
        gateway: epay.gateway || "https://api-pc.nandiu.com/xpay/epay/submit.php",
        pid: epay.pid,
        key: epay.key,
        type: epay.type || "alipay",
        outTradeNo,
        money: order.money,
        name: plan.name,
        notifyUrl: `${base}/api/pay/notify`,
        returnUrl: `${base}/api/pay/return?out_trade_no=${outTradeNo}`,
        sitename: epay.sitename || "无限画布",
        param: user.id,
        clientIp: clientIp(req),
    });

    ok(res, { outTradeNo, payUrl, params, money: order.money, planName: plan.name });
}

function orderView(order) {
    return {
        outTradeNo: order.outTradeNo,
        planName: order.planName,
        days: order.days,
        money: order.money,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
    };
}

function getOrder(req, res, outTradeNo) {
    const db = load();
    const user = requireUser(req);
    const order = db.orders.find((item) => item.outTradeNo === outTradeNo);
    if (!order || order.userId !== user.id) throw new HttpError(404, "order_not_found", "订单不存在");
    ok(res, { order: orderView(order), user: publicUser(user, db.settings) });
}

/** 支付成功后按套餐天数顺延（未到期则从到期日续期，已过期从当前时间起算）。 */
function activate(user, days) {
    const now = Date.now();
    const current = user.paidUntil ? new Date(user.paidUntil).getTime() : 0;
    const base = current > now ? current : now;
    user.paidUntil = new Date(base + days * 86400000).toISOString();
}

async function notify(req, res, url) {
    const db = load();
    const settings = db.settings;
    const epay = settings.epay || {};
    if (!epay.key) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("fail");
        return;
    }

    const query = Object.fromEntries(url.searchParams.entries());
    const body = req.method === "POST" ? await readBody(req) : {};
    const params = { ...query, ...body };

    if (!verifyNotify(params, epay.key)) {
        console.warn("[license] notify 验签失败", { out_trade_no: params.out_trade_no });
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("fail");
        return;
    }

    const order = db.orders.find((item) => item.outTradeNo === params.out_trade_no);
    if (!order) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("fail");
        return;
    }

    if (params.trade_status !== "TRADE_SUCCESS") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("success");
        return;
    }

    if (!sameMoney(params.money, order.money)) {
        console.warn("[license] notify 金额不符", { order: order.outTradeNo, paid: params.money, want: order.money });
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("fail");
        return;
    }

    if (order.status !== "paid") {
        order.status = "paid";
        order.paidAt = nowISO();
        order.tradeNo = String(params.trade_no || "");
        order.payType = String(params.type || order.payType);
        const user = db.users.find((item) => item.id === order.userId);
        if (user) activate(user, Number(order.days) || 0);
        saveNow();
        console.log(`[license] 订单已激活 ${order.outTradeNo} ${order.email} +${order.days}天`);
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end("success");
}

function payReturn(req, res, url) {
    const db = load();
    const target = `${siteUrl(req, db.settings)}/purchase?order=${encodeURIComponent(url.searchParams.get("out_trade_no") || "")}`;
    res.writeHead(302, { location: target });
    res.end();
}

/* ---------------- 后台 ---------------- */

function adminPassword() {
    const value = (process.env.LICENSE_ADMIN_PASSWORD || "").trim();
    if (value) return value;
    return "admin123";
}

async function adminLogin(req, res) {
    const body = await readBody(req);
    const ip = clientIp(req);
    if (!rateLimit(`admin:ip:${ip}`, 10, 10 * 60 * 1000)) throw new HttpError(429, "admin_limited", "尝试过于频繁，请稍后再试");
    const password = String(body.password || "");
    const expected = adminPassword();
    if (password.length !== expected.length || !verifyPasswordLike(password, expected)) {
        throw new HttpError(401, "admin_bad_password", "口令不正确");
    }
    ok(res, { token: signToken({ scope: "admin" }, ADMIN_TOKEN_TTL), defaultPassword: !process.env.LICENSE_ADMIN_PASSWORD });
}

/** 邮件自检：远程部署时用来确认 SMTP 出网与凭据是否正确（只有后台能调）。 */
async function adminTestMail(req, res) {
    requireAdmin(req);
    if (!mailerConfigured()) throw new HttpError(400, "smtp_missing", "服务端未配置 SMTP，无法发送");
    const body = await readBody(req);
    const to = String(body.to || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, "bad_email", "请填写正确的收件邮箱");
    const started = Date.now();
    await sendMail({
        to,
        subject: "无限画布授权服务：邮件自检",
        text: `这是一封来自授权服务的自检邮件。\n\n收到说明 SMTP 配置正确、出网通畅。\n耗时 ${Date.now() - started} ms（不含网络排队）。`,
    });
    ok(res, { sent: true, ms: Date.now() - started });
}

/** 常量时间比较，避免口令逐字节试探。 */
function verifyPasswordLike(input, expected) {
    const a = Buffer.from(input, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function adminOverview(req, res) {
    requireAdmin(req);
    const db = load();
    const now = Date.now();
    const state = (user) => userState(user, db.settings).state;
    const paidOrders = db.orders.filter((order) => order.status === "paid");
    ok(res, {
        users: db.users.length,
        trialing: db.users.filter((user) => state(user) === "trial").length,
        active: db.users.filter((user) => state(user) === "active").length,
        expired: db.users.filter((user) => state(user) === "expired").length,
        disabled: db.users.filter((user) => user.status === "disabled").length,
        orders: db.orders.length,
        paidOrders: paidOrders.length,
        revenue: paidOrders.reduce((sum, order) => sum + Number(order.money || 0), 0).toFixed(2),
        todaySignups: db.users.filter((user) => now - new Date(user.createdAt).getTime() < 86400000).length,
        smtpConfigured: mailerConfigured(),
        devEchoCode,
    });
}

function adminGetSettings(req, res) {
    requireAdmin(req);
    const db = load();
    const epay = db.settings.epay || {};
    ok(res, {
        settings: {
            ...db.settings,
            // 密钥不回传给前端，只回“是否已配置”
            epay: { ...epay, key: epay.key ? "******" : "", hasKey: Boolean(epay.key) },
        },
        smtpConfigured: mailerConfigured(),
        devEchoCode,
        dbFile,
    });
}

async function adminPutSettings(req, res) {
    requireAdmin(req);
    const db = load();
    const body = await readBody(req);
    const s = body.settings || {};
    const target = db.settings;

    if (s.paywallEnabled !== undefined) target.paywallEnabled = Boolean(s.paywallEnabled);
    if (s.trialDays !== undefined) target.trialDays = Math.max(0, Math.min(365, Number(s.trialDays) || 0));
    if (s.requireEmailCode !== undefined) target.requireEmailCode = Boolean(s.requireEmailCode);
    if (s.siteUrl !== undefined) target.siteUrl = String(s.siteUrl || "").trim().replace(/\/+$/, "");
    if (s.notice !== undefined) target.notice = String(s.notice || "");
    if (Array.isArray(s.emailDomains)) {
        target.emailDomains = s.emailDomains
            .map((item) => String(item).trim().toLowerCase().replace(/^@/, ""))
            .filter(Boolean);
    }
    if (s.epay && typeof s.epay === "object") {
        const epay = target.epay;
        if (s.epay.gateway !== undefined) epay.gateway = String(s.epay.gateway || "").trim();
        if (s.epay.pid !== undefined) epay.pid = String(s.epay.pid || "").trim();
        if (s.epay.type !== undefined) epay.type = String(s.epay.type || "alipay").trim();
        if (s.epay.sitename !== undefined) epay.sitename = String(s.epay.sitename || "").trim();
        // 密钥只在传入非空且非掩码时覆盖
        if (s.epay.key !== undefined && s.epay.key !== "" && s.epay.key !== "******") epay.key = String(s.epay.key).trim();
    }
    saveNow();
    ok(res, { settings: { ...target, epay: { ...target.epay, key: target.epay.key ? "******" : "", hasKey: Boolean(target.epay.key) } } });
}

function adminPlans(req, res) {
    requireAdmin(req);
    const db = load();
    ok(res, { plans: db.plans.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)) });
}

async function adminSavePlan(req, res, id) {
    requireAdmin(req);
    const db = load();
    const body = await readBody(req);
    const plan = id ? db.plans.find((item) => item.id === id) : null;
    if (id && !plan) throw new HttpError(404, "plan_not_found", "套餐不存在");

    const input = body.plan || {};
    const target = plan || { id: newId("plan"), sort: (db.plans.at(-1)?.sort || 0) + 10, active: true };
    if (input.name !== undefined) target.name = String(input.name).trim().slice(0, 40);
    if (input.days !== undefined) target.days = Math.max(1, Math.min(3650, Number(input.days) || 0));
    if (input.price !== undefined) target.price = Number(input.price).toFixed(2);
    if (input.originalPrice !== undefined) target.originalPrice = input.originalPrice === "" ? "" : Number(input.originalPrice).toFixed(2);
    if (input.desc !== undefined) target.desc = String(input.desc || "").slice(0, 200);
    if (input.badge !== undefined) target.badge = String(input.badge || "").slice(0, 12);
    if (input.sort !== undefined) target.sort = Number(input.sort) || 0;
    if (input.active !== undefined) target.active = Boolean(input.active);

    if (!target.name || !target.days || target.price === undefined) throw new HttpError(400, "invalid_plan", "套餐名称、天数、价格不能为空");
    if (!plan) db.plans.push(target);
    saveNow();
    ok(res, { plan: target, plans: db.plans.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)) });
}

function adminDeletePlan(req, res, id) {
    requireAdmin(req);
    const db = load();
    const plan = db.plans.find((item) => item.id === id);
    if (!plan) throw new HttpError(404, "plan_not_found", "套餐不存在");
    const used = db.orders.some((order) => order.planId === id && order.status === "paid");
    if (used) {
        // 已售出的套餐不物理删除，避免历史订单失去关联
        plan.active = false;
        saveNow();
        ok(res, { deleted: false, archived: true, plans: db.plans });
        return;
    }
    db.plans = db.plans.filter((item) => item.id !== id);
    saveNow();
    ok(res, { deleted: true, plans: db.plans });
}

function adminUsers(req, res, url) {
    requireAdmin(req);
    const db = load();
    const keyword = (url.searchParams.get("q") || "").trim().toLowerCase();
    const list = db.users
        .filter((user) => !keyword || user.email.includes(keyword) || user.id.includes(keyword))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 500)
        .map((user) => ({
            ...publicUser(user, db.settings),
            lastLoginAt: user.lastLoginAt,
            note: user.note || "",
            paidOrders: db.orders.filter((order) => order.userId === user.id && order.status === "paid").length,
        }));
    ok(res, { users: list, total: db.users.length });
}

async function adminUserAction(req, res, id) {
    requireAdmin(req);
    const db = load();
    const body = await readBody(req);
    const user = db.users.find((item) => item.id === id);
    if (!user) throw new HttpError(404, "user_not_found", "用户不存在");

    const action = String(body.action || "");
    if (action === "activate") {
        const days = Math.max(1, Math.min(3650, Number(body.days) || 0));
        activate(user, days);
        if (user.status === "disabled") user.status = "normal";
        user.note = String(body.note || user.note || "");
    } else if (action === "disable") {
        user.status = "disabled";
    } else if (action === "enable") {
        user.status = "normal";
    } else if (action === "reset-trial") {
        user.trialEndsAt = new Date(Date.now() + Math.max(0, Number(body.days ?? db.settings.trialDays) || 0) * 86400000).toISOString();
        user.paidUntil = null;
    } else {
        throw new HttpError(400, "invalid_action", "不支持的操作");
    }
    saveNow();
    ok(res, { user: { ...publicUser(user, db.settings), note: user.note || "" } });
}

function adminOrders(req, res, url) {
    requireAdmin(req);
    const db = load();
    const status = url.searchParams.get("status") || "";
    const list = db.orders
        .filter((order) => !status || order.status === status)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 500);
    ok(res, { orders: list });
}

async function adminMarkPaid(req, res, outTradeNo) {
    requireAdmin(req);
    const db = load();
    const order = db.orders.find((item) => item.outTradeNo === outTradeNo);
    if (!order) throw new HttpError(404, "order_not_found", "订单不存在");
    if (order.status === "paid") {
        ok(res, { order });
        return;
    }
    order.status = "paid";
    order.paidAt = nowISO();
    order.tradeNo = order.tradeNo || "MANUAL";
    const user = db.users.find((item) => item.id === order.userId);
    if (user) activate(user, Number(order.days) || 0);
    saveNow();
    ok(res, { order });
}

/* ---------------- 路由分发 ---------------- */

export async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = (req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    if (path === "/api/health") {
        // 带一点存储侧信息：多实例部署时靠它判断「这个实例读到的库是不是最新的」
        const db = load();
        return ok(res, {
            service: "infinite-canvas-license",
            time: nowISO(),
            store: { users: db.users.length, orders: db.orders.length },
            mail: { configured: mailerConfigured() },
        });
    }

    if (path === "/api/settings" && method === "GET") {
        const db = load();
        return ok(res, { settings: settingsView(db.settings), plans: plansView(db.plans) });
    }

    if (path === "/api/auth/send-code" && method === "POST") return sendCode(req, res);
    if (path === "/api/auth/register" && method === "POST") return register(req, res);
    if (path === "/api/auth/login" && method === "POST") return login(req, res);
    if (path === "/api/auth/me" && method === "GET") return me(req, res);

    if (path === "/api/pay/create" && method === "POST") return createOrder(req, res);
    if (path === "/api/pay/notify") return notify(req, res, url);
    if (path === "/api/pay/return") return payReturn(req, res, url);
    const orderMatch = /^\/api\/pay\/order\/([\w-]+)$/.exec(path);
    if (orderMatch && method === "GET") return getOrder(req, res, orderMatch[1]);

    if (path === "/api/admin/login" && method === "POST") return adminLogin(req, res);
    if (path === "/api/admin/test-mail" && method === "POST") return adminTestMail(req, res);
    if (path === "/api/admin/overview" && method === "GET") return adminOverview(req, res);
    if (path === "/api/admin/settings" && method === "GET") return adminGetSettings(req, res);
    if (path === "/api/admin/settings" && method === "PUT") return adminPutSettings(req, res);
    if (path === "/api/admin/plans" && method === "GET") return adminPlans(req, res);
    if (path === "/api/admin/plans" && method === "POST") return adminSavePlan(req, res, null);
    const planMatch = /^\/api\/admin\/plans\/([\w-]+)$/.exec(path);
    if (planMatch && method === "PUT") return adminSavePlan(req, res, planMatch[1]);
    if (planMatch && method === "DELETE") return adminDeletePlan(req, res, planMatch[1]);
    if (path === "/api/admin/users" && method === "GET") return adminUsers(req, res, url);
    const userMatch = /^\/api\/admin\/users\/([\w-]+)\/action$/.exec(path);
    if (userMatch && method === "POST") return adminUserAction(req, res, userMatch[1]);
    if (path === "/api/admin/orders" && method === "GET") return adminOrders(req, res, url);
    const markMatch = /^\/api\/admin\/orders\/([\w-]+)\/paid$/.exec(path);
    if (markMatch && method === "POST") return adminMarkPaid(req, res, markMatch[1]);

    throw new HttpError(404, "not_found", "接口不存在");
}

export function errorPayload(error) {
    if (error instanceof HttpError) {
        return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message, ...(error.details || {}) } } };
    }
    return { status: 500, body: { ok: false, error: { code: "internal_error", message: error?.message || "服务端异常" } } };
}

export { epaySign };
