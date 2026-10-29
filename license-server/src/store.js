/**
 * 极简 JSON 持久化：整库读入内存，写入时落盘（原子替换），写操作串行化。
 *
 * 选择 JSON 而不是 SQLite：服务端要做到零依赖部署（node src/index.js 即可跑），
 * 同时避免 better-sqlite3 在目标机器上编译失败。单实例、千人级用户量完全够用；
 * 需要横向扩容时应换成数据库，替换本模块即可（对外只暴露 get/save）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LICENSE_DATA_DIR || join(here, "..", "data");
const DB_FILE = join(DATA_DIR, "db.json");

/** 默认邮箱域名白名单：QQ / 谷歌 / 网易 / 新浪 及主流国内邮箱。 */
export const DEFAULT_EMAIL_DOMAINS = [
    "qq.com",
    "foxmail.com",
    "vip.qq.com",
    "gmail.com",
    "googlemail.com",
    "163.com",
    "126.com",
    "yeah.net",
    "vip.163.com",
    "vip.126.com",
    "sina.com",
    "sina.cn",
    "vip.sina.com",
    "sohu.com",
    "139.com",
    "189.cn",
    "21cn.com",
    "aliyun.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "icloud.com",
    "me.com",
    "yahoo.com",
];

export const DEFAULT_SETTINGS = {
    /** 是否开启付费墙：关闭时全部功能免费，账号只用于识别身份。 */
    paywallEnabled: true,
    /** 注册后赠送的免费天数，0 表示注册即需付费。 */
    trialDays: 3,
    /** 邮箱域名白名单（小写，不带 @）。 */
    emailDomains: DEFAULT_EMAIL_DOMAINS,
    /** 注册是否必须邮箱验证码。SMTP 未配置时会自动降级为 false。 */
    requireEmailCode: true,
    /** 前端站点地址，用于支付同步跳转（return_url）与后台展示。 */
    siteUrl: "",
    /** 站点公告，会显示在购买页。 */
    notice: "",
    epay: {
        gateway: "https://api-pc.nandiu.com/xpay/epay/submit.php",
        pid: "",
        key: "",
        type: "alipay",
        sitename: "无限画布",
    },
};

export const DEFAULT_PLANS = [
    {
        id: "plan-month",
        name: "月度会员",
        days: 31,
        price: "29.00",
        originalPrice: "39.00",
        desc: "31 天全功能使用，含全部画布能力与后续更新",
        badge: "",
        active: true,
        sort: 10,
    },
    {
        id: "plan-quarter",
        name: "季度会员",
        days: 93,
        price: "69.00",
        originalPrice: "117.00",
        desc: "93 天使用期，平均每月约 23 元",
        badge: "推荐",
        active: true,
        sort: 20,
    },
    {
        id: "plan-year",
        name: "年度会员",
        days: 366,
        price: "199.00",
        originalPrice: "468.00",
        desc: "366 天使用期，一年内免费获得全部版本更新",
        badge: "最超值",
        active: true,
        sort: 30,
    },
];

function emptyDb() {
    return {
        version: 1,
        settings: structuredClone(DEFAULT_SETTINGS),
        plans: structuredClone(DEFAULT_PLANS),
        users: [],
        orders: [],
        codes: [],
    };
}

let db = null;
let saveTimer = null;
/** 上次读到/写入的 db.json 指纹（mtime+size），用于判断磁盘上的库是否被别人改过。 */
let fingerprint = "";

function mergeDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            target[key] = mergeDefaults(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
        } else if (target[key] === undefined) {
            target[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    return target;
}

function stamp() {
    try {
        const info = statSync(DB_FILE);
        return `${info.mtimeMs}:${info.size}`;
    } catch {
        return "";
    }
}

function hydrate(raw) {
    const parsed = raw;
    mergeDefaults(parsed.settings, DEFAULT_SETTINGS);
    if (!Array.isArray(parsed.plans) || parsed.plans.length === 0) parsed.plans = structuredClone(DEFAULT_PLANS);
    for (const key of ["users", "orders", "codes"]) if (!Array.isArray(parsed[key])) parsed[key] = [];
    return parsed;
}

/**
 * 读取数据库。
 *
 * 关键点：**每次调用都先看磁盘有没有变化**。Wasmer Edge 这类平台会把同一个应用起多份
 * 实例，每个实例都是独立进程，模块级的 `db` 缓存会让实例之间永久不一致（实测：A 实例写
 * 完设置，B 实例连着 12 次读到的都是旧值）。所以这里的缓存只做「同一份文件不重复解析」，
 * 一旦 mtime/size 变了就重新读，保证多实例最终看到同一份数据。
 */
export function load() {
    mkdirSync(DATA_DIR, { recursive: true });
    const now = stamp();
    if (db && now && now === fingerprint) return db;
    if (existsSync(DB_FILE)) {
        const raw = readFileSync(DB_FILE, "utf8");
        try {
            db = hydrate(JSON.parse(raw));
        } catch (error) {
            // 写一半断电之类的坏文件：留一份现场，不要让整个服务起不来
            console.error("[store] db.json 解析失败，已备份为 db.json.broken", error?.message || error);
            writeFileSync(`${DB_FILE}.broken`, raw, "utf8");
            db = hydrate(emptyDb());
        }
    } else if (!db) {
        db = hydrate(emptyDb());
    }
    fingerprint = now;
    return db;
}

/**
 * 立即落盘（原子替换，避免写一半断电留下坏文件）。
 *
 * 刻意写成**同步**：Wasmer Edge / 各种 serverless 运行时会在响应返回后立刻把实例
 * 冻结甚至杀掉，任何基于 setTimeout 的延迟写都不会执行（实测：注册接口返回 200，
 * 用户却在重启后消失）。这里不追求吞吐，只保证「返回给用户的一定已经写进磁盘」。
 */
export function saveNow() {
    if (!db) return Promise.resolve();
    const data = JSON.stringify(db, null, 2);
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${DB_FILE}.tmp`;
        writeFileSync(tmp, data, "utf8");
        renameSync(tmp, DB_FILE);
        // 自己写的结果就是最新状态，同步指纹，避免下一次 load() 白读一遍
        fingerprint = stamp();
    } catch (error) {
        console.error("[store] save failed", error?.message || error);
    }
    return Promise.resolve();
}

/**
 * 合并高频写入（验证码、订单状态），最多 200ms 落一次盘。
 *
 * 只在「同一进程会继续处理更多请求」的长驻部署里划算；serverless 上必须用
 * saveNow()。当前所有**用户可见的状态变更**都走 saveNow()，这里仅保留给可容忍
 * 丢失的中间态（验证码、限流计数）。
 */
export function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveNow().catch((error) => console.error("[store] save failed", error));
    }, 200);
}

export function dataDir() {
    return DATA_DIR;
}

export const dbFile = DB_FILE;
