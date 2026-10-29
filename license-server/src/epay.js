/**
 * 易支付（码支付系统）协议实现。
 * 文档：https://api-pc.nandiu.com/doc/epay_submit
 *   - 下单：POST {gateway}（也支持拼成 URL 跳转）
 *   - 参数：pid type out_trade_no notify_url return_url name money sitename param clientip device
 *   - 签名：参数名 ASCII 升序，剔除 sign/sign_type/空值，拼成 a=b&c=d，末尾直接接商户密钥，md5 小写
 *   - 通知：GET/POST 回传 pid trade_no out_trade_no type name money trade_status sign sign_type，
 *           只有 trade_status=TRADE_SUCCESS 为成功，接收方需返回纯文本 success
 */
import { createHash } from "node:crypto";

/** 计算签名。values 不做 URL 编码。 */
export function epaySign(params, key) {
    const keys = Object.keys(params)
        .filter((k) => k !== "sign" && k !== "sign_type")
        .filter((k) => {
            const v = params[k];
            return v !== undefined && v !== null && String(v) !== "";
        })
        .sort();
    const plain = keys.map((k) => `${k}=${params[k]}`).join("&");
    return createHash("md5").update(plain + key, "utf8").digest("hex").toLowerCase();
}

/** 组装表单字段（含签名），返回可直接拼 URL 或 POST 的参数对象。 */
export function buildSubmitParams({ gateway, pid, key, type, outTradeNo, money, name, notifyUrl, returnUrl, sitename, param, clientIp }) {
    const params = {
        pid,
        type,
        out_trade_no: outTradeNo,
        notify_url: notifyUrl,
        return_url: returnUrl,
        name,
        money,
        sitename: sitename || "",
        param: param || "",
        clientip: clientIp || "",
        device: "pc",
        sign_type: "MD5",
    };
    params.sign = epaySign(params, key);
    const query = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && String(v) !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
    return { params, payUrl: `${gateway}${gateway.includes("?") ? "&" : "?"}${query}` };
}

/** 校验异步通知签名。 */
export function verifyNotify(params, key) {
    if (!params || !params.sign) return false;
    const expect = epaySign(params, key);
    const got = String(params.sign).toLowerCase();
    return expect.length === got.length && expect === got;
}

/** 金额比较：容差 1 分，避免 "29.0" / "29.00" 之类的格式差异。 */
export function sameMoney(a, b) {
    const x = Number.parseFloat(a);
    const y = Number.parseFloat(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return Math.abs(x - y) < 0.005;
}

/* ---------------- API 模式（页内二维码） ---------------- */

/**
 * 由网关地址推导 API 下单端点。
 *
 * 文档：`POST /xpay/epay/mapi.php`（与 submit.php 同参数，但返回 JSON）。
 * 后台填的网关一般是 submit.php，这里自动换成 mapi.php；已经填了 mapi.php 就原样用。
 */
export function apiEndpoint(gateway) {
    const value = String(gateway || "").trim();
    if (!value) return "";
    if (/mapi\.php/i.test(value)) return value;
    if (/submit\.php/i.test(value)) return value.replace(/submit\.php/i, "mapi.php");
    return `${value.replace(/\/+$/, "")}/mapi.php`;
}

/** 同一批参数拼成 form-urlencoded 请求体（值需要编码，与签名时的明文无关）。 */
function formEncode(params) {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join("&");
}

/**
 * API 模式下单：平台返回二维码内容 / 跳转链接 / 小程序 scheme 三者之一，
 * 前端据此在自己的页面里画二维码，不再跳到支付平台。
 *
 * 返回值：{ code, msg, tradeNo, payUrl, qrCode, urlScheme, money }
 *   code === 1 才算成功；其余情况交给调用方决定是否降级成收银台跳转。
 */
export async function createApiOrder(options) {
    const endpoint = apiEndpoint(options.gateway);
    if (!endpoint) throw new Error("支付网关地址为空");

    const params = {
        pid: options.pid,
        type: options.type,
        out_trade_no: options.outTradeNo,
        notify_url: options.notifyUrl,
        return_url: options.returnUrl,
        name: options.name,
        money: options.money,
        sitename: options.sitename || "",
        param: options.param || "",
        clientip: options.clientIp || "",
        device: options.device || "pc",
        sign_type: "MD5",
    };
    params.sign = epaySign(params, options.key);

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formEncode(params),
        signal: AbortSignal.timeout(options.timeoutMs || 12000),
    });

    const text = await response.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        // 有些网关错误时直接吐 HTML/纯文本，这里截断后抛出，便于后台排查
        throw new Error(`支付接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
    }
    if (!response.ok) throw new Error(`支付接口 HTTP ${response.status}：${data && (data.msg || data.message) ? data.msg || data.message : "请求失败"}`);

    return {
        code: Number(data.code),
        msg: String(data.msg || data.message || ""),
        tradeNo: String(data.trade_no || ""),
        payUrl: String(data.payurl || ""),
        qrCode: String(data.qrcode || ""),
        urlScheme: String(data.urlscheme || ""),
        money: String(data.money || ""),
    };
}
