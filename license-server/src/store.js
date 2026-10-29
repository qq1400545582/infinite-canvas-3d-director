/**
 * 极简 JSON 持久化：整库读入内存，写入时落盘（原子替换），写操作串行化。
 *
 * 选择 JSON 而不是 SQLite：服务端要做到零依赖部署（node src/index.js 即可跑），
 * 同时避免 better-sqlite3 在目标机器上编译失败。单实例、千人级用户量完全够用；
 * 需要横向扩容时应换成数据库，替换本模块即可（对外只暴露 get/save）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
let saving = Promise.resolve();

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

export function load() {
    if (db) return db;
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(DB_FILE)) {
        db = JSON.parse(readFileSync(DB_FILE, "utf8"));
    } else {
        db = emptyDb();
    }
    // 兼容后续新增的配置项：旧库缺字段时补默认值，不覆盖已有值
    mergeDefaults(db.settings, DEFAULT_SETTINGS);
    if (!Array.isArray(db.plans) || db.plans.length === 0) db.plans = structuredClone(DEFAULT_PLANS);
    for (const key of ["users", "orders", "codes"]) if (!Array.isArray(db[key])) db[key] = [];
    return db;
}

/** 立即落盘（原子替换，避免写一半断电留下坏文件）。 */
export function saveNow() {
    const data = JSON.stringify(db, null, 2);
    saving = saving.then(() => {
        const tmp = `${DB_FILE}.tmp`;
        writeFileSync(tmp, data, "utf8");
        renameSync(tmp, DB_FILE);
    });
    return saving;
}

/** 合并高频写入（验证码、订单状态），最多 200ms 落一次盘。 */
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
