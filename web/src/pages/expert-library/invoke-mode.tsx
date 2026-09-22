import { Modal, Button } from "antd";

import { useAgentStore } from "@/stores/use-agent-store";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";

import { invokeInCanvas } from "./invoke";
import { KIND_LABELS, type LibraryItem } from "./data/types";

/**
 * 调用方式选择：在「直接调用」（现有智能体面板形式）与「作为节点调用」之间二选一。
 * 节点调用复用画布公开的 Agent 指令集（canvasContext.applyOps 的 add_node，
 * 与智能体操作画布同一条链路），不触碰宿主其它模块；专家库节点定义
 * 已在本模块内注册（library-nodes.tsx）。
 */

export type InvokeMode = "direct" | "node";
export type InvokeItemResult = "connected" | "no-agent" | "placed" | "no-canvas" | "cancelled";

let dialogRoot: HTMLDivElement | null = null;

function ensureDialogRoot() {
    if (!dialogRoot || !document.body.contains(dialogRoot)) {
        dialogRoot = document.createElement("div");
        document.body.appendChild(dialogRoot);
    }
    return dialogRoot;
}

/** 弹出「直接调用 / 作为节点调用」选择框；关闭（Esc / 遮罩）返回 null。 */
export function chooseInvokeMode(item: LibraryItem): Promise<InvokeMode | null> {
    return new Promise((resolve) => {
        ensureDialogRoot();
        let settled = false;
        const done = (mode: InvokeMode | null) => {
            if (settled) return;
            settled = true;
            resolve(mode);
            modal.destroy();
        };
        const option = (mode: InvokeMode, title: string, description: string) => (
            <Button
                key={mode}
                block
                size="large"
                className="!h-auto !items-start !justify-start !py-3 !text-left"
                onClick={() => done(mode)}
            >
                <span className="block font-semibold">{title}</span>
                <span className="mt-1 block text-xs font-normal opacity-70">{description}</span>
            </Button>
        );
        const modal = Modal.info({
            title: `调用「${item.name}」`,
            content: (
                <div className="flex flex-col gap-2 pt-1">
                    {option("direct", "直接调用", "在右侧智能体面板中打开，立即对话执行（当前形式）。")}
                    {option("node", "作为节点调用", `作为${KIND_LABELS[item.kind]}节点放置到画布，可连线到其它节点反复使用。`)}
                </div>
            ),
            icon: null,
            width: 380,
            maskClosable: true,
            okButtonProps: { style: { display: "none" } },
            cancelText: "取消",
            onCancel: () => done(null),
        });
        void modal;
    });
}

/** 画布当前视口中心的世界坐标（Agent 快照里的 viewport 与屏幕坐标同源）。 */
function viewportCenterWorld(): { x: number; y: number } {
    const context = useAgentStore.getState().canvasContext;
    if (!context) return { x: 0, y: 0 };
    const { viewport } = context.snapshot;
    return {
        x: (window.innerWidth / 2 - viewport.x) / viewport.k,
        y: (window.innerHeight / 2 - viewport.y) / viewport.k,
    };
}

const KIND_PREFIX: Record<LibraryItem["kind"], string> = { expert: "expert", skill: "skill", connector: "connector" };

/** 把条目作为节点放置到画布视口中心；返回是否成功（仅在画布页可用）。 */
export function placeLibraryNode(item: LibraryItem): boolean {
    const context = useAgentStore.getState().canvasContext;
    if (!context) return false;
    const center = viewportCenterWorld();
    const ops: CanvasAgentOp[] = [
        {
            type: "add_node",
            nodeType: `expert-library:${KIND_PREFIX[item.kind]}-${item.id}`,
            title: `${KIND_LABELS[item.kind]} · ${item.name}`,
            position: { x: center.x - 132, y: center.y - 78 },
        },
    ];
    context.applyOps(ops);
    return true;
}

/** 所有专家库调用入口的统一入口：先选择调用方式，再执行对应调用。 */
export async function invokeItem(item: LibraryItem): Promise<InvokeItemResult> {
    const mode = await chooseInvokeMode(item);
    if (!mode) return "cancelled";
    if (mode === "node") {
        // 节点定义可能尚未注册（例如未打开过专家库页面）——动态加载注册表后再放置。
        try {
            const { registerLibraryNodes } = await import("./library-nodes");
            registerLibraryNodes();
        } catch {
            /* 注册失败时按原节点类型回退：add_node 会落到文本节点，不中断 */
        }
        return placeLibraryNode(item) ? "placed" : "no-canvas";
    }
    return await invokeInCanvas(item);
}
