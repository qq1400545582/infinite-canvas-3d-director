import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ImageIcon, List, Music2, Settings2, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getNodeDefinition, listNodeDefinitions, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type ConnectionHandle, type Position } from "@/types/canvas";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

// ---------------------------------------------------------------------------
// 太极图主节点选择器（双击画布空白）
// ---------------------------------------------------------------------------
// 8 个主节点按用户约定顺序摆在八卦位上（自顶部起逆时针，与先天八卦图一致）：
//   文本(天乾/顶) 图片(泽兑) 视频(火离) 更多(雷震) OpenReel(地坤/底)
//   3D导演台(山艮) 分镜工作台(水坎) 白模预演台(风巽)
// 「更多」槽位点击后展开次级列表：其它节点、节点插件、本地插件（开关已启用者）。
// 内置节点按 type 匹配；插件节点按标题匹配（插件未启用时该卦位灰显不可点）。
// 「双击右键」同样可呼出次级列表（NodeCreateMenu），作为快捷方式保留。

const BAGUA_ORDER = ["trigram-qian", "trigram-dui", "trigram-li", "trigram-zhen", "trigram-kun", "trigram-gen", "trigram-kan", "trigram-xun"] as const;

const PRIMARY_NODE_SLOTS: Array<{ icon?: string; bagua: (typeof BAGUA_ORDER)[number]; kind?: "more"; builtin?: CanvasNodeType; pluginTitle?: string }> = [
    { bagua: "trigram-qian", builtin: CanvasNodeType.Text },
    { bagua: "trigram-dui", builtin: CanvasNodeType.Image },
    { bagua: "trigram-li", builtin: CanvasNodeType.Video },
    { bagua: "trigram-zhen", kind: "more" },
    { bagua: "trigram-kun", pluginTitle: "OpenReel 视频编辑" },
    { bagua: "trigram-gen", pluginTitle: "3D 导演台" },
    { bagua: "trigram-kan", pluginTitle: "分镜工作台" },
    { bagua: "trigram-xun", pluginTitle: "白模预演台" },
];

const BAGUA_LABELS: Record<(typeof BAGUA_ORDER)[number], { glyph: string; name: string }> = {
    "trigram-qian": { glyph: "☰", name: "天乾" },
    "trigram-dui": { glyph: "☱", name: "泽兑" },
    "trigram-li": { glyph: "☲", name: "火离" },
    "trigram-zhen": { glyph: "☳", name: "雷震" },
    "trigram-kun": { glyph: "☷", name: "地坤" },
    "trigram-gen": { glyph: "☶", name: "山艮" },
    "trigram-kan": { glyph: "☵", name: "水坎" },
    "trigram-xun": { glyph: "☴", name: "风巽" },
};

/** 解析 8 个主节点槽位：返回可用定义与缺失槽位（插件未启用）。标题匹配忽略空格差异。「更多」槽位恒可用。 */
export function resolvePrimaryNodeSlots() {
    const byTitle = new Map<string, ReturnType<typeof listNodeDefinitions>[number]>();
    listNodeDefinitions().forEach((def) => {
        byTitle.set(def.title.replace(/\s+/g, ""), def);
    });
    return PRIMARY_NODE_SLOTS.map((slot) => {
        const type = slot.builtin || (slot.pluginTitle ? byTitle.get(slot.pluginTitle.replace(/\s+/g, ""))?.type : undefined);
        const definition = type ? getNodeDefinition(type) : undefined;
        return { ...slot, type: type || "", definition, available: slot.kind === "more" || Boolean(definition) };
    });
}

const BAGUA_RADIUS = 132;
const BAGUA_MENU_SIZE = (BAGUA_RADIUS + 56) * 2;

function TaijiMark() {
    return (
        <svg
            viewBox="0 0 100 100"
            // 居中用 inset-0 + margin:auto（不依赖 translate/scale 工具类）：
            // Tailwind v4 的 -translate-* 是独立 translate 属性，会与 transform 叠加导致双重偏移。
            // 静态经典太极（用户参考图）：黑鱼头在下、白鱼头在上、粗描边；铺满中心区（半径 75 < 卦位内缘 86）。
            className="pointer-events-none absolute inset-0 m-auto size-[150px]"
        >
            <circle cx="50" cy="50" r="46" fill="#f5f2ec" stroke="#1c1917" strokeWidth="5" />
            <path d="M50 4 A46 46 0 0 1 50 96 A23 23 0 0 1 50 50 A23 23 0 0 0 50 4 Z" fill="#1c1917" />
            <circle cx="50" cy="73" r="6.5" fill="#f5f2ec" />
            <circle cx="50" cy="27" r="6.5" fill="#1c1917" />
        </svg>
    );
}

export function BaguaNodeCreateMenu({ position, onCreate, onMore, onClose }: { position: Position; onCreate: (type: string) => void; onMore: () => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const registryVersion = useNodeRegistryVersion((state) => state.version);
    const menuRef = useRef<HTMLDivElement>(null);
    const slots = useMemo(() => resolvePrimaryNodeSlots(), [registryVersion]);
    const { t } = useTranslation();

    // 与 NodeCreateMenu 同款：菜单位于缩放世界层，防止溢出画布可视区。
    useLayoutEffect(() => {
        const menu = menuRef.current;
        const canvas = menu?.parentElement?.parentElement;
        if (!menu || !canvas) return;
        const fit = () => {
            menu.style.left = `${position.x}px`;
            menu.style.top = `${position.y}px`;
            const scale = menu.getBoundingClientRect().width / menu.offsetWidth;
            if (!Number.isFinite(scale) || scale <= 0) return;
            const bounds = canvas.getBoundingClientRect();
            const margin = 8;
            const rect = menu.getBoundingClientRect();
            const left = Math.max(bounds.left + margin, Math.min(rect.left, bounds.right - rect.width - margin));
            const top = Math.max(bounds.top + margin, Math.min(rect.top, bounds.bottom - rect.height - margin));
            menu.style.left = `${position.x + (left - rect.left) / scale}px`;
            menu.style.top = `${position.y + (top - rect.top) / scale}px`;
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [position.x, position.y, registryVersion]);

    // 点击菜单外自动关闭。
    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            className="absolute z-[120] rounded-full"
            data-canvas-no-zoom
            data-bagua-create-menu
            style={{ left: position.x, top: position.y, width: BAGUA_MENU_SIZE, height: BAGUA_MENU_SIZE, transform: "translate(-50%, -50%)" }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            {/* 装饰外环 */}
            <div className="pointer-events-none absolute inset-3 rounded-full border border-dashed" style={{ borderColor: theme.node.stroke, opacity: 0.55 }} />
            <div className="pointer-events-none absolute inset-8 rounded-full border" style={{ borderColor: theme.node.stroke, opacity: 0.3 }} />
            {/* 中心太极 */}
            <TaijiMark />
            {/* 八卦位主节点 */}
            {slots.map((slot, index) => {
                const angle = (-90 + index * -45) * (Math.PI / 180);
                const cx = BAGUA_MENU_SIZE / 2 + Math.cos(angle) * BAGUA_RADIUS;
                const cy = BAGUA_MENU_SIZE / 2 + Math.sin(angle) * BAGUA_RADIUS;
                const bagua = BAGUA_LABELS[slot.bagua];
                const odd = index % 2 === 0;
                const isMore = slot.kind === "more";
                const label = isMore ? t("canvas.createMenu.more") : slot.definition?.title || slot.pluginTitle || "";
                return (
                    <button
                        key={slot.bagua}
                        type="button"
                        disabled={!slot.available}
                        title={isMore ? t("canvas.createMenu.otherNodes") : slot.available ? slot.definition?.title : `${slot.pluginTitle || slot.definition?.title || ""}（插件未启用）`}
                        className="absolute z-0 grid size-[92px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border text-center transition duration-200 hover:z-10 hover:enabled:scale-110 disabled:cursor-not-allowed"
                        style={{
                            left: cx,
                            top: cy,
                            background: theme.node.panel,
                            borderColor: odd ? "#dc2626" : "#1c1917",
                            color: theme.node.text,
                            opacity: slot.available ? 1 : 0.38,
                            boxShadow: odd ? "0 0 0 3px rgba(220,38,38,.08)" : "0 0 0 3px rgba(28,25,23,.06)",
                        }}
                        onClick={() => {
                            if (!slot.available) return;
                            if (isMore) {
                                onMore();
                                return;
                            }
                            if (!slot.type) return;
                            onCreate(slot.type);
                        }}
                    >
                        <span className="absolute left-1/2 top-[-11px] -translate-x-1/2 rounded-full border px-1.5 text-[10px] leading-[18px]"
                            style={{ background: odd ? "#dc2626" : "#1c1917", borderColor: theme.node.panel, color: "#f5f2ec", whiteSpace: "nowrap" }}>
                            {bagua.glyph} {bagua.name}
                        </span>
                        <span className="text-xl leading-none">{isMore ? "⋯" : slot.definition?.icon || slot.icon || "·"}</span>
                        <span className="mt-0.5 line-clamp-2 px-1 text-[10.5px] leading-tight" style={{ color: theme.node.muted }}>
                            {label}
                        </span>
                    </button>
                );
            })}
            {/* 关闭按钮 */}
            <button
                type="button"
                aria-label={t("canvas.createMenu.close")}
                className="absolute left-1/2 top-1/2 z-10 grid size-6 -translate-x-1/2 translate-y-[46px] place-items-center rounded-full opacity-50 transition hover:opacity-100"
                style={{ background: theme.node.fill, color: theme.node.text }}
                onClick={onClose}
            >
                <X className="size-3.5" />
            </button>
        </div>
    );
}

export function ConnectionCreateMenu({
    pending,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio) => void;
    onClose: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x, top: pending.position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.fromNode")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    ×
                </button>
            </div>
            <div className="flex flex-col gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title={t("canvas.createMenu.text")} description={t("canvas.createMenu.textDescription")} onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title={t("canvas.createMenu.image")} onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title={t("canvas.createMenu.video")} onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Music2 className="size-5" />} title={t("canvas.createMenu.audio")} onClick={() => onCreate(CanvasNodeType.Audio)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title={t("canvas.createMenu.config")} description={t("canvas.createMenu.configDescription")} onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

export function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

export function NodeCreateMenu({ position, onCreate, onClose, excludeTypes }: { position: Position; onCreate: (type: string) => void; onClose: () => void; excludeTypes?: ReadonlySet<string> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const registryVersion = useNodeRegistryVersion((state) => state.version);
    const menuRef = useRef<HTMLDivElement>(null);
    // 次级菜单：排除太极图上的 8 个主节点，展示其余节点/插件（开关已启用即已注册）。
    const definitions = listNodeDefinitions().filter((def) => def.showInCreateMenu !== false && !(excludeTypes && excludeTypes.has(def.type)));
    // The menu lives in the scaled world layer. Keep its full scroll area inside
    // the clipping canvas; moving the menu must not change the node creation point.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        const canvas = menu?.parentElement?.parentElement;
        if (!menu || !canvas) return;
        const fit = () => {
            menu.style.left = `${position.x}px`;
            menu.style.top = `${position.y}px`;
            const scale = menu.getBoundingClientRect().width / menu.offsetWidth;
            if (!Number.isFinite(scale) || scale <= 0) return;
            const bounds = canvas.getBoundingClientRect();
            const margin = 8;
            menu.style.maxHeight = `${Math.max(1, Math.min(window.innerHeight * 0.7, bounds.height - margin * 2) / scale)}px`;
            const rect = menu.getBoundingClientRect();
            const left = Math.max(bounds.left + margin, Math.min(rect.left, bounds.right - rect.width - margin));
            const top = Math.max(bounds.top + margin, Math.min(rect.top, bounds.bottom - rect.height - margin));
            menu.style.left = `${position.x + (left - rect.left) / scale}px`;
            menu.style.top = `${position.y + (top - rect.top) / scale}px`;
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [position.x, position.y, registryVersion]);
    // Close automatically when clicking outside the menu.
    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handlePointerDown, true);
        return () => document.removeEventListener("pointerdown", handlePointerDown, true);
    }, [onClose]);
    return (
        <div
            ref={menuRef}
            className="absolute z-[120] max-h-[70vh] w-[300px] overflow-y-auto rounded-[18px] border p-3 shadow-2xl backdrop-blur thin-scrollbar"
            data-canvas-no-zoom
            style={{ left: position.x, top: position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.otherNodes")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    <X className="size-4" />
                </button>
            </div>
            <div className="flex flex-col gap-1">
                {definitions.length ? (
                    definitions.map((def) => <ConnectionCreateOption key={def.type} theme={theme} icon={def.icon} title={def.title} description={def.description} onClick={() => onCreate(def.type)} />)
                ) : (
                    <div className="px-2 py-6 text-center text-xs" style={{ color: theme.node.muted }}>
                        {t("canvas.createMenu.noOtherNodes")}
                    </div>
                )}
            </div>
        </div>
    );
}
