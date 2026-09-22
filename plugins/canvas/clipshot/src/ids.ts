// 节点类型与事件名常量（两个节点共用，避免循环依赖）
export const PLUGIN_ID = "clipshot";

/** 分镜工作台（上游）：按 Skill 规范拆镜头，产出分镜总图与逐格提示词 */
export const WORKBENCH_NODE_TYPE = "clipshot:workbench";

/** 分镜出图（下游）：连接在工作台之后，按分镜序列逐格出图 */
export const PANELS_NODE_TYPE = "clipshot:panels";

/** 工作台产出新分镜后广播；下游节点据此即时开工（另有轮询兜底） */
export const PANELS_READY_EVENT = "clipshot:panels-ready";
