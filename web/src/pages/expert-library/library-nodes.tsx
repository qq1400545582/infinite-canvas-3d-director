import { Play } from "lucide-react";

import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext, CanvasNodeDefinition } from "@/types/canvas-plugin";
import { resolveIcon } from "./components/icon-map";
import { experts } from "./data/experts";
import { skills } from "./data/skills";
import { connectors } from "./data/connectors";
import { invokeItem } from "./invoke-mode";
import { connectorToLibraryItem, installToLibraryItem, useUserLibrary, userLibrarySnapshot } from "./state/user-library";
import type { LibraryItem } from "./data/types";

const PLUGIN_ID = "expert-library";
const NODE_SIZE = { width: 264, height: 156 };

const KIND_PREFIX: Record<LibraryItem["kind"], string> = {
    expert: "expert",
    skill: "skill",
    connector: "connector",
};

const KIND_LABEL: Record<LibraryItem["kind"], string> = {
    expert: "专家",
    skill: "技能",
    connector: "连接器",
};

/**
 * 汇总需要在画布中作为节点暴露的条目：
 * 目录里的专家 / 技能 / 连接器 + 用户创建的「我的专家」+ 本地已安装的技能 + 自定义连接器。
 * 已安装技能若同名存在于目录中则不重复注册；自定义连接器 id 带 `my-connector:` 前缀，天然不与目录冲突。
 */
export function libraryItems(): LibraryItem[] {
    const snapshot = userLibrarySnapshot();
    const catalogSkillKeys = new Set<string>();
    for (const skill of skills) {
        catalogSkillKeys.add(skill.id.toLowerCase());
        catalogSkillKeys.add(skill.name.toLowerCase());
    }
    const installedSkills = snapshot.installs
        .filter((record) => !catalogSkillKeys.has(record.name.toLowerCase()))
        .map(installToLibraryItem);
    const userConnectors = snapshot.connectors.map(connectorToLibraryItem);
    return [...experts, ...snapshot.experts, ...skills, ...installedSkills, ...connectors, ...userConnectors];
}

function LibraryNodeContent({ ctx, item }: { ctx: CanvasNodeContext; item: LibraryItem }) {
    const Icon = resolveIcon(item.icon);
    const theme = ctx.theme;
    return (
        <div className="flex h-full w-full flex-col gap-2 p-3" style={{ color: theme.node.text }}>
            <div className="flex items-center gap-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-xl" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}>
                    <Icon className="size-4" />
                </span>
                <span className="truncate text-sm font-semibold">{item.name}</span>
            </div>
            <p className="overflow-hidden text-xs leading-4 opacity-80" style={{ maxHeight: 48 }}>
                {item.description}
            </p>
            <div className="mt-auto flex items-center justify-between gap-2">
                <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                >
                    {KIND_LABEL[item.kind]}
                </span>
                <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        void invokeItem(item);
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
                    style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }}
                >
                    <Play className="size-3.5" />
                    调用
                </button>
            </div>
        </div>
    );
}

function buildLibraryNodeDefinitions(items: LibraryItem[]): CanvasNodeDefinition[] {
    return items.map((item): CanvasNodeDefinition => {
        const Icon = resolveIcon(item.icon);
        return {
            type: `${PLUGIN_ID}:${KIND_PREFIX[item.kind]}-${item.id}`,
            // 节点标题保留「类型 · 名称」前缀，便于已放置节点在画布上辨认。
            title: `${KIND_LABEL[item.kind]} · ${item.name}`,
            icon: <Icon className="size-5" />,
            description: item.description,
            defaultSize: NODE_SIZE,
            // 专家库条目统一从专家库页面调用，不在「双击添加节点 / 工具栏扩展」菜单中暴露。
            showInCreateMenu: false,
            hasSourceHandle: true,
            Content: ({ ctx }: { ctx: CanvasNodeContext }) => <LibraryNodeContent ctx={ctx} item={item} />,
            toolbar: () => [
                {
                    id: "invoke",
                    title: "调用",
                    label: "调用",
                    icon: <Play className="size-4" />,
                    onClick: () => {
                        void invokeItem(item);
                    },
                },
            ],
            onDoubleClick: () => {
                void invokeItem(item);
                return true;
            },
        };
    });
}

let registeredSignature = "";

/** 注册 / 刷新专家库节点（用户新建专家或安装技能后重新注册）。 */
export function registerLibraryNodes(force = false) {
    const items = libraryItems();
    const signature = items.map((item) => `${item.kind}:${item.id}`).join("|");
    if (!force && signature === registeredSignature) return;
    registeredSignature = signature;
    unregisterPluginNodes(PLUGIN_ID);
    registerNodeDefinitions(buildLibraryNodeDefinitions(items), PLUGIN_ID);
}

/** 订阅用户数据变化，自动把新专家 / 新技能同步为画布节点。 */
export function subscribeLibraryNodes() {
    return useUserLibrary.subscribe(() => registerLibraryNodes());
}
