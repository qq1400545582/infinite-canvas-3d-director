/**
 * 优云智算（CompShare）实例的展示类型。
 *
 * 上游返回字段名不稳定（`InstanceId` / `UHostId` / `Id`、`Status` / `State`），
 * 所以在 Agent 侧已做一次宽松解析，前端只消费这里定义的稳定形态。
 */

export type CompShareInstance = {
    /** 实例短 ID（拼接入地址用） */
    id: string;
    name: string;
    /** 状态原文（Running / Stopped / Running 变体等） */
    status: string;
    /** 卡型（4090 / H20 / …） */
    gpuType: string;
    gpuCount: number;
    cpu: number;
    /** 内存（GB） */
    memoryGb: number;
    zone: string;
    chargeType: string;
    createdAt: string;
};

export type CompShareInstanceType = {
    gpuType: string;
    gpuCount: number;
    cpu: number;
    /** 内存（GB） */
    memoryGb: number;
    /** 支持的 CPU 平台 */
    cpuPlatform?: string;
    /** 是否支持抢占式 */
    spot?: boolean;
};

export type CompShareImage = {
    id: string;
    name: string;
    /** 系统 / 应用 / community（社区）/ custom（自制） */
    imageType: string;
    author: string;
    status: string;
    description: string;
    tags: string[];
    /** 封面图 URL（社区镜像列表页靠它识别；无封面时前端降级为占位块） */
    cover: string;
    /** 价格（元/小时，0 = 免费） */
    price: number;
    free: boolean;
    versionName: string;
    /** 该镜像支持的 GPU 卡型 */
    gpuTypes: string[];
    /** 镜像预置的软件端口（如 ComfyUI 6006） */
    softwarePorts: { name: string; port: number }[];
    usageCount: number;
    autoStart: boolean;
    container: boolean;
    /** 来源分组：platform | community | custom */
    source: "platform" | "community" | "custom";
};

export type CompShareOverview = {
    /** 部分接口失败时的原因清单（前端据此提示「哪些下拉为空、为什么」）。 */
    failures?: { part: string; error: string }[];
    /** 可用区列表（形如 cn-wlcb-01） */
    zones: string[];
    instanceTypes: CompShareInstanceType[];
    images: CompShareImage[];
    /** 平台侧社区镜像总数（可能大于已加载数：翻页有上限，未翻到的页需靠搜索补） */
    communityTotal?: number;
    instances: CompShareInstance[];
    total: number;
};
