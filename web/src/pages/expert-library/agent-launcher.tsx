import { Button, Modal, message as antdMessage } from "antd";

import { discoverAgentConfig } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

import { DEFAULT_AGENT_ENDPOINT } from "./agent-bridge";

/**
 * Canvas Agent 一键启动辅助。
 *
 * 浏览器沙箱无法直接拉起本机进程，因此采用「一键复制命令 → 自动等待本机 Agent 上线
 * → 自动填充 Local URL 并连接」的闭环：用户点一下按钮，剩下的检测与连接自动完成。
 * 只依赖画布已有的 store 方法与 canvas-agent API，不改动任何其它模块。
 *
 * 注意：antd 静态 message/Modal 不依赖 React 渲染上下文，可在事件回调中安全使用。
 */

const AGENT_COMMAND = "npx -y @basketikun/canvas-agent@latest";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180000;

export type LaunchOutcome = "connected" | "timeout" | "dismissed";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 探测本机 Agent 是否可发现（/config 免鉴权），返回发现的 URL。 */
async function discoverAgentUrl(endpoint: string): Promise<string | null> {
    try {
        const discovered = await discoverAgentConfig(endpoint);
        return discovered ? discovered.url || endpoint : null;
    } catch {
        return null;
    }
}

/**
 * 弹出一键启动对话框：复制命令 → 轮询等待 Agent 上线 → 自动连接。
 * token 已保存时自动连接；否则停留在连接页等待用户粘贴 token（Agent 会自动发现）。
 * 「最小化」关闭弹窗但继续后台探测；「取消」停止探测。
 */
export function launchAgentAssistant(onOutcome?: (outcome: LaunchOutcome) => void): void {
    const endpoint = (useAgentStore.getState().url || DEFAULT_AGENT_ENDPOINT).trim().replace(/\/+$/, "") || DEFAULT_AGENT_ENDPOINT;
    let stopped = false; // 用户取消：停止探测
    let closed = false; // 弹窗已关闭（最小化或取消）
    let reported = false;
    const report = (outcome: LaunchOutcome) => {
        if (!reported) {
            reported = true;
            onOutcome?.(outcome);
        }
    };

    const modal = Modal.info({
        title: "一键启动 Canvas Agent",
        content: (
            <div className="flex flex-col gap-3 text-sm leading-6">
                <p>在终端运行下面的命令启动本机 Canvas Agent（需要已安装 Node.js；首次运行会自动下载安装依赖）：</p>
                <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-700 dark:bg-stone-800">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{AGENT_COMMAND}</code>
                    <Button
                        size="small"
                        type="primary"
                        onClick={() => {
                            void navigator.clipboard
                                ?.writeText(AGENT_COMMAND)
                                .then(() => antdMessage.success("命令已复制，请到终端粘贴运行"))
                                .catch(() => antdMessage.error("复制失败，请手动选择命令复制"));
                        }}
                    >
                        复制命令
                    </Button>
                </div>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                    复制后本窗口会自动探测 Agent 上线（约每 2 秒一次，最多等待 3 分钟），上线后自动连接并关闭。
                    点「最小化」可先关掉弹窗、后台继续探测。
                </p>
            </div>
        ),
        icon: null,
        width: 520,
        maskClosable: false,
        okText: "最小化",
        cancelText: "取消",
        onOk: () => {
            closed = true; // Modal.info 点击 OK 后自动关闭弹窗，探测继续
        },
        onCancel: () => {
            stopped = true;
            closed = true;
            report("dismissed");
        },
    });

    void (async () => {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (!stopped && Date.now() < deadline) {
            const discovered = await discoverAgentUrl(endpoint);
            if (stopped) return;
            if (discovered) {
                const store = useAgentStore.getState();
                store.setAgentState({ url: discovered, activeTab: "setup" });
                store.openPanel();
                // 已保存 token 时直接连接；否则停在连接页等用户粘贴 token（连接后即可用）。
                if (store.token.trim()) store.connectAgent({ silent: false });
                if (!closed) modal.destroy();
                antdMessage.success("已检测到 Canvas Agent 上线");
                report("connected");
                return;
            }
            await sleep(POLL_INTERVAL_MS);
        }
        if (!stopped) {
            antdMessage.warning("等待超时：未检测到 Canvas Agent 上线，可稍后重试或手动连接");
            report("timeout");
        }
    })();
}
