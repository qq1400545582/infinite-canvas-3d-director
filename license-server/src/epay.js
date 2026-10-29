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
