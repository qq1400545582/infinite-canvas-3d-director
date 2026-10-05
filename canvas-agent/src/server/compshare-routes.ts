import fs from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";

import { decodeBase64, openSftp, resolveWithin, SftpError, DEFAULT_SFTP_ROOT, type SftpTarget } from "./compshare-sftp.js";
import { probeInstance } from "./compshare-probe.js";
import {
    buildEndpoints,
    checkResourceCapacity,
    CompShareError,
    CompShareNoKeyError,
    createInstance,
    DEFAULT_VLLM_API_KEY,
    describePlatformImages,
    describeCommunityImages,
    describeCustomImages,
    describeSoftwarePorts,
    describeInstanceTypes,
    describeInstances,
    describeSupportZone,
    releaseInstance,
    startInstance,
    stopInstance,
    type CompShareCredentials,
} from "./compshare.js";

/**
 * 优云智算 GPU 实例的 HTTP 端点。
 *
 * 鉴权沿用 Agent 自身的 token 机制（`http.ts` 已挂全局鉴权中间件），密钥**永不下发前端**：
 * 前端只能「设置 / 清除 / 探测是否已配置」，读不到私钥内容。
 *
 * 端点分两类：
 *   · 只读（GET）：库存规格、可用区、镜像、实例列表、接入信息；
 *   · 写（POST）：创建、开关机、释放 —— 全部**产生费用或不可逆**，故额外要求
 *     请求体带 `confirm: true`，前端用二次确认弹窗把关；缺 confirm 一律 400。
 *
 * 密钥落盘在 `<workspace>/.compshare.json`（与 SkillStore 同纪律：不进 git、不写 metadata）。
 */
export type CompShareConfig = { publicKey: string; privateKey: string; region?: string; vllmApiKey?: string };

const CONFIG_FILE = ".compshare.json";

function configPath(workspacePath: () => string) {
    return path.join(workspacePath(), CONFIG_FILE);
}

/** 读取已配置的凭据；未配置返回 null（由调用方给出可行动提示）。 */
export function compShareCredentials(workspacePath: () => string): CompShareCredentials | null {
    const config = readConfig(workspacePath);
    if (!config.publicKey.trim() || !config.privateKey.trim()) return null;
    return { publicKey: config.publicKey, privateKey: config.privateKey };
}

function readConfig(workspacePath: () => string): CompShareConfig {
    try {
        const raw = fs.readFileSync(configPath(workspacePath), "utf8");
        const parsed = JSON.parse(raw) as Partial<CompShareConfig>;
        return { publicKey: String(parsed.publicKey || ""), privateKey: String(parsed.privateKey || ""), region: parsed.region, vllmApiKey: parsed.vllmApiKey };
    } catch {
        return { publicKey: "", privateKey: "" };
    }
}

function writeConfig(workspacePath: () => string, config: CompShareConfig) {
    fs.writeFileSync(configPath(workspacePath), JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** 统一的错误响应：把平台错误码带上，前端可据此分流。 */
function fail(res: Response, error: unknown) {
    if (error instanceof CompShareNoKeyError) return res.status(428).json({ ok: false, code: "NO_KEY", error: error.message });
    if (error instanceof CompShareError) return res.status(200).json({ ok: false, code: "UPSTREAM", retCode: error.retCode, error: error.message });
    return res.status(500).json({ ok: false, code: "INTERNAL", error: error instanceof Error ? error.message : String(error) });
}

export type CompShareDeps = { workspacePath: () => string };

export function registerCompShare(app: Express, deps: CompShareDeps) {
    const creds = (): CompShareCredentials | null => {
        const config = readConfig(deps.workspacePath);
        if (!config.publicKey.trim() || !config.privateKey.trim()) return null;
        return { publicKey: config.publicKey, privateKey: config.privateKey };
    };
    const region = () => readConfig(deps.workspacePath).region || undefined;

    // ——— 密钥管理（读接口只回「是否已配置」，不回内容） ———
    app.get("/agent/compshare/config", (_req: Request, res: Response) => {
        const config = readConfig(deps.workspacePath);
        res.json({
            ok: true,
            data: {
                configured: Boolean(config.publicKey.trim() && config.privateKey.trim()),
                publicKeyMasked: config.publicKey ? `${config.publicKey.slice(0, 6)}****${config.publicKey.slice(-4)}` : "",
                region: config.region || "",
                vllmApiKey: config.vllmApiKey || DEFAULT_VLLM_API_KEY,
            },
        });
    });

    app.post("/agent/compshare/config", async (req: Request, res: Response) => {
        const body = (req.body || {}) as Partial<CompShareConfig>;
        const next = readConfig(deps.workspacePath);
        if (typeof body.publicKey === "string") next.publicKey = body.publicKey.trim();
        if (typeof body.privateKey === "string") next.privateKey = body.privateKey.trim();
        if (typeof body.region === "string") next.region = body.region.trim();
        if (typeof body.vllmApiKey === "string") next.vllmApiKey = body.vllmApiKey.trim();
        try {
            writeConfig(deps.workspacePath, next);
            res.json({ ok: true, data: { configured: Boolean(next.publicKey && next.privateKey) } });
        } catch (error) {
            res.status(500).json({ ok: false, code: "WRITE_FAILED", error: error instanceof Error ? error.message : String(error) });
        }
    });

    // ——— 只读查询 ———
    app.get("/agent/compshare/overview", async (_req: Request, res: Response) => {
        try {
            const key = creds();
            // 并行取三份目录：规格（决定 CPU/内存合法组合）、镜像、现有实例
            // 镜像分三类拉取（平台/社区/自制），任一失败不影响其余——社区镜像可能因
            // 账号权限或区域限制取不到，此时仍应能用系统镜像创建实例。
            // **每一项独立容错**：任一项失败只让对应下拉为空，并把原因写进 failures，
            // 其余照常返回。否则一项失败就整体抛错，前端所有下拉全空、且看不到真实原因
            // （这正是「地域/镜像/CPU/内存全空但看不出为什么」的成因）。
            // fallback 类型用 any：各接口返回结构不同，强行统一会让 TS 推断失败
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const attempt = async (label: string, run: () => Promise<any>, fallback: any) => {
                try {
                    return await run();
                } catch (error) {
                    const message = error instanceof CompShareError ? `错误码 ${error.retCode}：${error.message}` : error instanceof Error ? error.message : String(error);
                    failures.push({ part: label, error: message });
                    return fallback;
                }
            };
            const failures: { part: string; error: string }[] = [];
            const emptyZones = { Zones: [] as unknown[] };
            const emptyTypes = { InstanceTypes: [] as unknown[] };
            const emptyInstances = { Instances: [] as unknown[], TotalCount: 0 };
            const emptyPlatform = { ImageSet: [] as unknown[] };
            const emptyCommunity = { CompshareImageGroup: [] as unknown[], TotalCount: 0 };

            const [zones, types, instances, platform, community, custom] = await Promise.all([
                attempt("可用区", () => describeSupportZone(key!), emptyZones),
                attempt("机型规格", () => describeInstanceTypes(key!), emptyTypes),
                attempt("实例列表", () => describeInstances(key!, region() || undefined), emptyInstances),
                attempt("官方镜像", () => describePlatformImages(key!), emptyPlatform),
                // 社区镜像量大（上千条），翻页拉取；任一页失败则返回已取到的部分
                attempt("社区镜像", () => fetchAllCommunityImages(key!, region() || "cn-wlcb"), emptyCommunity),
                attempt("自制镜像", () => describeCustomImages(key!), emptyPlatform),
            ]);
            res.json({
                ok: true,
                data: {
                    zones: (zones.Zones || []).map((zone: Record<string, unknown>) => String(zone.Zone || "")).filter(Boolean),
                    instanceTypes: normalizeInstanceTypes(types.InstanceTypes || []),
                    images: [
                        // 社区镜像排前面：它才是用户要的「镜像社区」，官方系统镜像是兜底
                        ...normalizeImages(flattenCommunityGroups(community.CompshareImageGroup || []), "community"),
                        ...normalizeImages(platform.ImageSet || [], "platform"),
                        ...normalizeImages(custom.ImageSet || [], "custom"),
                    ],
                    communityTotal: (community as { TotalCount?: number }).TotalCount ?? 0,
                    instances: normalizeInstances((instances as { Instances?: unknown[] }).Instances || []),
                    total: (instances as { TotalCount?: number }).TotalCount ?? 0,
                    // 部分失败时前端据此提示「哪些下拉为空、为什么」，而不是静默空着
                    failures,
                },
            });
        } catch (error) {
            fail(res, error);
        }
    });

    /** 某实例的接入信息（8000/v1、8001/gpu-stats、6006、vLLM Key）。 */
    app.get("/agent/compshare/endpoints", (req: Request, res: Response) => {
        const instanceId = String(req.query.instanceId || "").trim();
        if (!instanceId) return res.status(400).json({ ok: false, code: "BAD_REQUEST", error: "缺少 instanceId" });
        res.json({ ok: true, data: buildEndpoints(instanceId, readConfig(deps.workspacePath).vllmApiKey || DEFAULT_VLLM_API_KEY) });
    });

    // ——— 写操作：一律要求 confirm:true ———
    const requireConfirm = (req: Request, res: Response) => {
        if (req.body?.confirm === true) return true;
        res.status(400).json({ ok: false, code: "NEED_CONFIRM", error: "该操作会产生费用或不可逆变更，请在确认后再执行（confirm=true）" });
        return false;
    };

    /**
     * 库存预检（只读，不计费）：前端在「创建实例」弹窗里先调它。
     *
     * 文档明确要求创建前必须用 `CheckCompShareResourceCapacity` 判断库存
     * （不能用 Describe 类接口代替），所以单独暴露一个只读端点。
     */
    app.post("/agent/compshare/instances/capacity", async (req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: await checkResourceCapacity(creds()!, (req.body?.params || {}) as Record<string, unknown>) });
        } catch (error) {
            fail(res, error);
        }
    });

    /** 创建实例（会计费，需 confirm）。 */
    app.post("/agent/compshare/instances/create", async (req: Request, res: Response) => {
        if (!requireConfirm(req, res)) return;
        try {
            const result = await createInstance(creds()!, (req.body?.params || {}) as Record<string, unknown>);
            res.json({ ok: true, data: result });
        } catch (error) {
            fail(res, error);
        }
    });

    app.post("/agent/compshare/instances/:id/:action", async (req: Request, res: Response) => {
        if (!requireConfirm(req, res)) return;
        // Express 5 的路由参数类型是 string | string[]，这里统一取字符串
        const id = String(req.params.id);
        try {
            const action = String(req.params.action);
            if (action === "start") res.json({ ok: true, data: await startInstance(creds()!, id) });
            else if (action === "stop") res.json({ ok: true, data: await stopInstance(creds()!, id) });
            else if (action === "release") res.json({ ok: true, data: await releaseInstance(creds()!, id) });
            else res.status(400).json({ ok: false, code: "BAD_ACTION", error: `不支持的操作：${action}` });
        } catch (error) {
            fail(res, error);
        }
    });
}

/* ── 上游字段宽松解析 ──
 * UCloud 系列接口的字段名在不同动作里并不统一（实例 ID 有 InstanceId / UHostId / Id 三种写法，
 * 状态有 Status / State）。前端只该看到一种形态，所以在这里收敛一次。
 */

function firstOf(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
}

function toNumber(value: unknown) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function normalizeInstances(raw: unknown[]): Record<string, unknown>[] {
    return raw.map((entry) => {
        const instance = entry as Record<string, unknown>;
        const memory = toNumber(firstOf(instance, ["Memory", "Mem"]));
        return {
            id: String(firstOf(instance, ["InstanceId", "UHostId", "Id", "CompShareInstanceId"]) || ""),
            name: String(firstOf(instance, ["Name", "InstanceName", "Remark"]) || ""),
            status: String(firstOf(instance, ["Status", "State", "InstanceStatus"]) || ""),
            // SSH 连接线索（SshLoginCommand 形如 `ssh root@1.2.3.4 -p 60022`）。
            // Password 是 Base64 密文，**不明文下发**；页面只拿它做「是否已提供」的提示。
            ssh: normalizeSshInfo(instance),
            gpuType: String(firstOf(instance, ["GpuType", "GPUType"]) || ""),
            gpuCount: toNumber(firstOf(instance, ["GPU", "GpuCount", "GPUCount"])),
            cpu: toNumber(firstOf(instance, ["CPU", "CpuCount"])),
            // 上游内存单位是 MB，前端按 GB 显示（卡片只做展示，避免毫/GB 换算错）
            memoryGb: memory ? Math.round(memory / 1024) : 0,
            zone: String(firstOf(instance, ["Zone", "AvailabilityZone"]) || ""),
            chargeType: String(firstOf(instance, ["ChargeType", "PayType"]) || ""),
            createdAt: String(firstOf(instance, ["CreateTime", "CreatedAt"]) || ""),
        };
    }).filter((instance) => instance.id);
}

function normalizeInstanceTypes(raw: unknown[]) {
    return raw.map((entry) => {
        const type = entry as Record<string, unknown>;
        const memory = toNumber(firstOf(type, ["Memory", "Mem"]));
        return {
            gpuType: String(firstOf(type, ["GpuType", "GPUType"]) || ""),
            gpuCount: toNumber(firstOf(type, ["GPU", "GpuCount", "MaxGPU"])),
            cpu: toNumber(firstOf(type, ["CPU", "CpuCount"])),
            memoryGb: memory ? Math.round(memory / 1024) : 0,
            cpuPlatform: String(firstOf(type, ["MinimalCpuPlatform", "CpuPlatform"]) || ""),
            spot: Boolean(firstOf(type, ["SupportSpot", "Spot"])),
        };
    }).filter((type) => type.gpuType);
}

export { normalizeSshInfo };

/** 从实例信息里解析 SSH 线索：优先用 SshLoginCommand 的 `user@host -p port`，否则回退 IPSet。 */
function normalizeSshInfo(instance: Record<string, unknown>) {
    const command = String(firstOf(instance, ["SshLoginCommand"]) || "");
    const matched = /([a-zA-Z0-9_-]+)@([\d.]+)[^\d]*(\d{2,5})/.exec(command);
    const ipSet = Array.isArray(instance.IPSet) ? (instance.IPSet as Record<string, unknown>[]) : [];
    const publicIp = ipSet.map((ip) => String(ip.IP || "")).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || "";
    return {
        // 平台 GPU 实例的 SSH 端口由平台分配（文档示例为 60022），不要假设是 22
        host: matched?.[2] || publicIp,
        port: Number(matched?.[3] || 0),
        username: matched?.[1] || "root",
        // 仅为 true/false，前端据此提示「平台返回了加密密码，需手动填写」
        hasEncodedPassword: Boolean(instance.Password),
        osType: String(firstOf(instance, ["OsType"]) || ""),
    };
}

/**
 * 探测实例能否被画布调用（只读，不产生费用）。
 *
 * 前端拿这个结果决定两件事：① 这个实例能喂给画布哪类节点（文本/图像/视频/音频）；
 * ② 「接入画布」按钮要不要可用（探测不通过时不该让用户白点一次）。
 */
export function registerCompShareProbe(app: Express) {
    app.post("/agent/compshare/instances/:id/probe", async (req: Request, res: Response) => {
        // 探测是只读操作，不需要 confirm（confirm 只用于创建/释放等计费或不可逆操作）
        const id = String(req.params.id || "").trim();
        if (!id) {
            res.status(400).json({ ok: false, code: "BAD_REQUEST", error: "缺少实例 ID" });
            return;
        }
        try {
            // 允许前端覆盖 vLLM Key：镜像预置值可能与用户实际设置的不同
            const apiKey = String((req.body?.apiKey as string) || "").trim();
            const result = await probeInstance(id, apiKey || undefined);
            res.json({ ok: true, data: result });
        } catch (error) {
            fail(res, error);
        }
    });
}

/**
 * 按关键词检索社区镜像（服务端精确搜索，只读）。
 *
 * 用途：本地已加载的镜像里搜不到时（例如镜像在未翻到的页），让用户按
 * **镜像名称或作者**到平台侧再查一次 —— 平台的 `FuzzySearch` 是真模糊匹配，
 * 比前端 contains 准。返回结构与 overview 的 images 段一致，前端可直接合并。
 */
export function registerCompShareImageSearch(app: Express, deps: { workspacePath: () => string }) {
    // 地域从 compshare 自己的配置里读（不放全局 CanvasAgentConfig —— 那是 Agent 的配置，
    // 混入平台地域会污染既有结构）
    const region = () => readConfig(deps.workspacePath).region || "cn-wlcb";
    app.post("/agent/compshare/images/search", async (req: Request, res: Response) => {
        try {
            const creds = compShareCredentials(deps.workspacePath);
            if (!creds) {
                res.json({ ok: true, data: { images: [], keyword: "", searched: false } });
                return;
            }
            const keyword = String((req.body?.keyword as string) || "").trim();
            if (!keyword) {
                res.json({ ok: true, data: { images: [], keyword: "", searched: false } });
                return;
            }
            // FuzzySearch 同时匹配镜像名与作者，正是用户「按名称或作者搜」的场景
            const result = await describeCommunityImages(creds, { FuzzySearch: keyword, Limit: 60, Region: region() });
            const groups = (result as { CompshareImageGroup?: unknown[] }).CompshareImageGroup || [];
            const images = normalizeImages(flattenCommunityGroups(groups), "community");
            res.json({
                ok: true,
                data: {
                    images,
                    keyword,
                    searched: true,
                    total: Number((result as { TotalCount?: number }).TotalCount || 0),
                },
            });
        } catch (error) {
            if (error instanceof CompShareError) {
                res.json({ ok: true, data: { images: [], searched: false, error: `错误码 ${error.retCode}：${error.message}` } });
                return;
            }
            fail(res, error);
        }
    });
}

/**
 * 实例文件传输（SFTP 中转）：列目录 / 上传 / 下载 / 新建目录 / 删除。
 *
 * 凭据来源与兜底：
 *   · 平台 `DescribeCompShareInstance` 返回的 `Password` 是 Base64 密文，能解则用；
 *   · 解不出来时**不猜**，改用调用方在请求里传的 `password`（用户手填一次）。
 *   两种方式都拿不到则明确报错，不做静默重试。
 *
 * 路径安全：所有 `path` 参数都过 `resolveWithin`，越界直接 400。
 */
export function registerCompShareSftp(app: Express, deps: { instanceInfo: (instanceId: string) => Promise<{ ssh: { host: string; port: number; username: string; hasEncodedPassword: boolean; osType: string }; encodedPassword?: string }> }) {
    /** 解析本次请求要用的 SSH 目标：显式手填密码优先，否则用平台返回的（可解时）。 */
    const resolveTarget = async (body: Record<string, unknown>): Promise<SftpTarget> => {
        const instanceId = String(body.instanceId || "").trim();
        if (!instanceId) throw new SftpError("IO", "缺少 instanceId");
        const info = await deps.instanceInfo(instanceId);
        const ssh = info?.ssh;
        if (!ssh?.host) throw new SftpError("NO_CONNECTION", "该实例没有可用的 SSH 地址（仅 Linux 实例支持文件管理，且实例需处于运行中）");
        // 平台分配的是非标准端口；拿不到端口时明确报错而不是默认 22
        if (!ssh.port) throw new SftpError("NO_CONNECTION", "未能从实例信息里解析出 SSH 端口，请在实例详情页查看登录命令后手动填写端口");
        const manual = String(body.password || "").trim();
        let password = manual;
        if (!password && info.encodedPassword) {
            try {
                password = decodeBase64(info.encodedPassword);
            } catch {
                password = "";
            }
        }
        if (!password) {
            throw new SftpError("AUTH", ssh.hasEncodedPassword ? "平台返回的实例密码是加密格式，无法在本地解码。请在该实例的「文件管理」里手动填写一次登录密码。" : "缺少实例登录密码：请手动填写该实例的 root 密码。");
        }
        return { host: ssh.host, port: ssh.port, username: String(body.username || ssh.username || "root"), password };
    };

    const wrap = (handler: (body: Record<string, unknown>) => Promise<unknown>) => async (req: Request, res: Response) => {
        const body = (req.body || {}) as Record<string, unknown>;
        try {
            const data = await handler(body);
            res.json({ ok: true, data });
        } catch (error) {
            if (error instanceof SftpError) {
                res.status(error.code === "PATH_ESCAPE" ? 400 : 200).json({ ok: false, code: error.code, error: error.message });
                return;
            }
            res.status(500).json({ ok: false, code: "INTERNAL", error: error instanceof Error ? error.message : String(error) });
        }
    };

    app.post("/agent/compshare/sftp/list", wrap(async (body) => {
        const target = await resolveTarget(body);
        const root = String(body.root || DEFAULT_SFTP_ROOT);
        const dir = resolveWithin(root, String(body.path || "."));
        const sftp = await openSftp(target);
        try {
            const entries = await sftp.list(dir);
            return { dir, root, entries };
        } finally {
            sftp.end();
        }
    }));

    app.post("/agent/compshare/sftp/mkdir", wrap(async (body) => {
        const target = await resolveTarget(body);
        const dir = resolveWithin(String(body.root || DEFAULT_SFTP_ROOT), String(body.path || ""));
        const sftp = await openSftp(target);
        try {
            await sftp.mkdir(dir);
            return { dir };
        } finally {
            sftp.end();
        }
    }));

    app.post("/agent/compshare/sftp/remove", wrap(async (body) => {
        const target = await resolveTarget(body);
        const root = String(body.root || DEFAULT_SFTP_ROOT);
        const target_ = resolveWithin(root, String(body.path || ""));
        if (target_ === resolveWithin(root, ".")) throw new SftpError("PATH_ESCAPE", "不能删除根目录");
        const sftp = await openSftp(target);
        try {
            const entry = await sftp.stat(target_);
            if (!entry) throw new SftpError("NOT_FOUND", "目标不存在");
            if (entry.isDirectory) await sftp.rmdir(target_);
            else await sftp.unlink(target_);
            return { removed: target_ };
        } finally {
            sftp.end();
        }
    }));

    app.post("/agent/compshare/sftp/upload", wrap(async (body) => {
        const target = await resolveTarget(body);
        const remote = resolveWithin(String(body.root || DEFAULT_SFTP_ROOT), String(body.path || ""));
        const payload = String(body.payload || "");
        if (!payload) throw new SftpError("IO", "缺少文件内容（payload）");
        const data = Buffer.from(payload, "base64");
        const sftp = await openSftp(target);
        try {
            await sftp.writeBuffer(remote, data);
            return { path: remote, size: data.byteLength };
        } finally {
            sftp.end();
        }
    }));

    app.post("/agent/compshare/sftp/download", wrap(async (body) => {
        const target = await resolveTarget(body);
        const remote = resolveWithin(String(body.root || DEFAULT_SFTP_ROOT), String(body.path || ""));
        const sftp = await openSftp(target);
        try {
            const data = await sftp.readBuffer(remote);
            if (!data.byteLength) throw new SftpError("NOT_FOUND", "文件为空或不存在");
            return { path: remote, size: data.byteLength, payload: data.toString("base64") };
        } finally {
            sftp.end();
        }
    }));

}

/** 归一镜像：不同来源字段名不同（CompShareImageId / ImageId / Id），统一成一种形态。 */
/**
 * 拉取全部社区镜像（翻页合并）。
 *
 * 社区镜像有上千条，单页上限 100，必须翻页。翻页用 `Offset`（不是 Page）。
 * 任一页失败就返回已取到的部分 —— 宁可少几条，也不要整个社区分组空掉。
 */
async function fetchAllCommunityImages(creds: CompShareCredentials, region: string, maxPages = 12) {
    const groups: unknown[] = [];
    let total = 0;
    for (let page = 0; page < maxPages; page += 1) {
        const result = await describeCommunityImages(creds, { Offset: page * 100, Limit: 100, Region: region });
        const batch = (result as { CompshareImageGroup?: unknown[] }).CompshareImageGroup || [];
        groups.push(...batch);
        total = Number((result as { TotalCount?: number }).TotalCount || 0);
        // 不足一整页说明已到末尾
        const items = batch.reduce<number>((sum, group) => sum + (((group as { Data?: unknown[] }).Data || []).length), 0);
        if (items === 0 || groups.length * 100 >= total) break;
    }
    return { CompshareImageGroup: groups, TotalCount: total };
}

/**
 * 把社区镜像的**分组结构**拍平成镜像行数组。
 *
 * `DescribeCommunityImages` 返回 `CompshareImageGroup: [{ GroupId, ImageName, …, Data: [镜像, …] }]`，
 * 真正的镜像在 `Data` 里；组上的 `ImageName / ImageDesc` 作为兜底（个别版本的
 * `Data` 里 `Name` 可能为空）。
 */
function flattenCommunityGroups(groups: unknown[]) {
    const rows: Record<string, unknown>[] = [];
    for (const entry of groups) {
        if (!entry || typeof entry !== "object") continue;
        const group = entry as Record<string, unknown>;
        const data = Array.isArray(group.Data) ? (group.Data as unknown[]) : [];
        for (const image of data) {
            if (!image || typeof image !== "object") continue;
            const record = image as Record<string, unknown>;
            rows.push({
                ...record,
                // 组名兜底：版本名缺失时至少还能显示镜像名，不至于「无名镜像」
                Name: firstOf(record, ["Name", "ImageName"]) || group.ImageName || "",
                Description: firstOf(record, ["Description", "ImageDesc"]) || group.ImageDesc || "",
            });
        }
    }
    return rows;
}

/** 归一镜像：不同来源字段名不同（社区是 Name/Cover/Tags，平台是 ImageSet），统一成一种形态。 */
function normalizeImages(raw: unknown[], source: "platform" | "community" | "custom") {
    return raw
        .map((entry) => {
            // 上游数据不可信：可能夹 null / 非对象，必须先挡住，
            // 否则读 image.X 会整段抛错（这个崩溃是测试抓出来的）
            if (!entry || typeof entry !== "object") return null;
            const image = entry as Record<string, unknown>;
            const gpuTypes = Array.isArray(image.SupportedGpuTypes) ? (image.SupportedGpuTypes as unknown[]).map((item) => String(item)).filter(Boolean) : [];
            const price = Number(firstOf(image, ["Price"]) || 0);
            return {
                id: String(firstOf(image, ["CompShareImageId", "ImageId", "Id", "ImageUuid"]) || ""),
                name: String(firstOf(image, ["Name", "ImageName", "CompShareImageName"]) || ""),
                // 社区镜像的 ImageType 常为空，用 source 兜底以便页面分组
                imageType: String(firstOf(image, ["ImageType", "CompShareImageType"]) || source),
                author: String(firstOf(image, ["Author", "OwnerName", "CompShareImageAuthorAlias", "ImageOwnerAlias"]) || ""),
                status: String(firstOf(image, ["Status", "ImageStatus", "CompShareImageStatus"]) || ""),
                description: String(firstOf(image, ["Description", "ImageDesc"]) || "").slice(0, 200),
                // Tags 是**字符串数组**（社区文档明确 Array of String）；兼容早期对象数组形态
                tags: Array.isArray(image.Tags)
                    ? (image.Tags as unknown[]).map((tag) => String((tag as Record<string, unknown>)?.tagLabel ?? tag)).filter(Boolean).slice(0, 8)
                    : [],
                // 封面图：社区镜像列表页靠它识别，选镜像时没有封面很难挑
                cover: String(firstOf(image, ["Cover", "CoverUrl", "ImageCover", "Screenshot", "Logo"]) || ""),
                // 价格（元/小时，0 = 免费）—— 直接决定「创建实例会计费多少」
                price,
                free: price === 0,
                versionName: String(firstOf(image, ["VersionName"]) || ""),
                gpuTypes: gpuTypes.slice(0, 6),
                // 该镜像预置的软件端口（ComfyUI 6006 之类），用于创建时提示
                softwarePorts: Array.isArray(image.SoftwarePorts)
                    ? (image.SoftwarePorts as Record<string, unknown>[]).map((port) => ({ name: String(port?.Software || ""), port: Number(port?.Port || 0) })).filter((port) => port.name && port.port)
                    : [],
                usageCount: Number(firstOf(image, ["CreatedCount", "ImageUseTime"]) || 0),
                autoStart: Boolean(firstOf(image, ["AutoStart", "IfAutoStart"])),
                container: String(firstOf(image, ["Container"]) || "") === "True",
                source,
            };
        })
        .filter((image): image is NonNullable<typeof image> => Boolean(image?.id && image?.name));
}
