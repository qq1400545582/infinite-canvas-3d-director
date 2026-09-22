import { definePlugin } from "@infinite-canvas/plugin-sdk";

import { PANELS_NODE_TYPE, PLUGIN_ID, WORKBENCH_NODE_TYPE } from "./ids";
import { PanelsContent, panelsRegistries } from "./panels";
import { WorkbenchContent, workbenchRegistries } from "./workbench";

// 分镜工作台（clipshot）插件入口
// -----------------------------------------------------------------------------
// 把开源 Skill「cinematic-storyboard-design」(TanShilongMario/clipshot, MIT) 以两个画布节点落地：
//   · 分镜工作台（clipshot:workbench，上游）：按 Skill 原文规则拆镜头，产出分镜总图（格数可自定义，
//     默认 3×3 九宫格）+ 逐格图像提示词 + 时间线镜头表；
//   · 分镜出图（clipshot:panels，下游）：连接在工作台之后，按分镜序列逐格调用宿主图像模型出图，
//     每格落成一个画布图片节点。
//
// 提示词与规范逐字取自上游仓库（见 src/prompts.ts，由 tools/gen-prompts.mjs 生成）；
// 只有「网格规格随格数改写」与「输出契约」两处属于运行环境适配，见 src/spec.ts 顶部说明。
// 模型与密钥由宿主注入（ctx.ai），插件不自带、不读取 API Key。

export default definePlugin({
    id: PLUGIN_ID,
    name: "分镜工作台",
    version: "1.1.0",
    description: "分镜工作台：内置 cinematic-storyboard-design Skill（clipshot），把剧本拆成可自定义格数（默认九宫格）的制作型分镜与逐格提示词，并可连接下游「分镜出图」节点按分镜序列自动出图",
    nodes: [
        {
            type: WORKBENCH_NODE_TYPE,
            title: "分镜工作台",
            icon: "🎬",
            description: "按 clipshot Skill 规范把剧本转成分镜总图（默认 3×3 九宫格，格数可自定义）、逐格图像提示词与时间线镜头表（内置上游提示词原文）",
            defaultSize: { width: 880, height: 640 },
            defaultMetadata: {},
            minimapColor: "#8b5cf6",
            hasSourceHandle: true,
            // 内容整体可交互（表单）；拖拽靠标题栏。与内置文本节点的做法一致。
            interactionToggle: false,
            hidePanel: true,
            resource: (node) => {
                const plan = node.metadata?.clipshotPlan;
                return typeof plan === "string" && plan.trim() ? { kind: "text", text: plan } : null;
            },
            Content: WorkbenchContent,
            toolbar: (ctx) => [
                {
                    id: "clipshot-run",
                    title: "按 clipshot Skill 规范生成分镜（总图 + 逐格提示词）",
                    label: "生成分镜",
                    icon: "✨",
                    onClick: () => workbenchRegistries.run.get(ctx.node.id)?.(),
                },
                {
                    id: "clipshot-export",
                    title: "把分镜总图作为图片节点落到画布",
                    label: "导出总图",
                    icon: "🖼",
                    onClick: () => workbenchRegistries.exportGrid.get(ctx.node.id)?.(),
                },
                {
                    id: "clipshot-add-panels",
                    title: "新建并连接下游「分镜出图」节点（按分镜序列自动逐格出图）",
                    label: "分镜出图",
                    icon: "🧩",
                    onClick: () => workbenchRegistries.addPanels.get(ctx.node.id)?.(),
                },
                {
                    id: "clipshot-clear",
                    title: "清空本节点的分镜结果",
                    label: "清空",
                    icon: "🧹",
                    onClick: () => workbenchRegistries.clear.get(ctx.node.id)?.(),
                },
            ],
        },
        {
            type: PANELS_NODE_TYPE,
            title: "分镜出图",
            icon: "🧩",
            description: "连接在「分镜工作台」之后：按分镜序列逐格提取文生图提示词并出图，每格落成一个画布图片节点（自动出图可关）",
            defaultSize: { width: 720, height: 620 },
            defaultMetadata: {},
            minimapColor: "#8b5cf6",
            hasSourceHandle: true,
            interactionToggle: false,
            hidePanel: true,
            // 刻意不声明 resource：本节点只消费上游的元数据，不作为可被引用的资源节点。
            Content: PanelsContent,
            toolbar: (ctx) => [
                {
                    id: "clipshot-panels-run",
                    title: "按分镜序列逐格出图（已出图的格子会原地更新）",
                    label: "开始出图",
                    icon: "🖼",
                    onClick: () => panelsRegistries.run.get(ctx.node.id)?.(),
                },
                {
                    id: "clipshot-panels-clear",
                    title: "删除由本节点生成的图片节点",
                    label: "删除已出图",
                    icon: "🧹",
                    danger: true,
                    onClick: () => panelsRegistries.clear.get(ctx.node.id)?.(),
                },
            ],
        },
    ],
});
