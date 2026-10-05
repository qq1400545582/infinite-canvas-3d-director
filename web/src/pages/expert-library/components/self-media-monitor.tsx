import { Activity, Clock, FolderOpen, RefreshCw, Wifi } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { LIBTV_CHANNEL, LIBTV_CHANNEL_ID, useUserLibrary } from "../state/user-library";
import type { PullProgress } from "../channel-source";
import { selfMediaSkills } from "../data/self-media";

/**
 * 自媒体（LibTV）技能的实时监控条。
 *
 * 纯展示组件：拉取与错误提示由页面（专家库技能页）持有，组件只接收进度并触发回调。
 *
 * 与「拉取 WorkBuddy 更新」同一套语义：展示最后更新时间、上次条数摘要，
 * 点按钮实时拉取并显示「正在拉第 N 页 · 已得 M 条」。拉取完成后条目立即出现在列表里。
 *
 * 为什么监控与拉取在**前端**而不是走 Agent：LibTV 目录只是「展示 + 调用入口」，
 * 技能正文在对方平台；走 Agent 会把正文落盘到 `.agents/skills`（可执行文件），
 * 不该让一个外部地址获得本机写权限。
 */
export function SelfMediaMonitor({ pulling, progress, onUpdate, liveCount }: { pulling: boolean; progress: PullProgress | null; onUpdate: () => void; liveCount: number }) {
    const { t } = useTranslation();
    const channel = useUserLibrary((state) => state.channels).find((entry) => entry.id === LIBTV_CHANNEL_ID);
    const lastAt = channel?.lastAt;

    return (
        <div className="mb-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard icon={<FolderOpen className="size-4" />} label={t("selfMedia.stat.total")} value={t("selfMedia.stat.totalValue", { count: selfMediaSkills.length + liveCount })} hint={t("selfMedia.stat.totalHint", { bundled: selfMediaSkills.length, pulled: liveCount })} />
                <StatCard icon={<Wifi className={`size-4 ${pulling ? "animate-pulse text-emerald-500" : ""}`} />} label={t("selfMedia.stat.channel")} value={liveCount} hint={LIBTV_CHANNEL.name} live={pulling} />
                <StatCard
                    icon={<Clock className="size-4" />}
                    label={t("selfMedia.stat.lastUpdate")}
                    value={lastAt ? new Date(lastAt).toLocaleTimeString() : "—"}
                    hint={lastAt ? new Date(lastAt).toLocaleDateString() : t("selfMedia.stat.never")}
                />
                <StatCard
                    icon={<Activity className="size-4" />}
                    label={t("selfMedia.stat.status")}
                    value={pulling ? t("selfMedia.stat.pulling", { page: progress?.page ?? 0, count: progress?.count ?? 0 }) : t("selfMedia.stat.idle")}
                    hint={channel?.lastSummary || t("selfMedia.stat.idleHint")}
                    live={pulling}
                />
            </div>
            <div>
                <Button size="small" type="primary" icon={<RefreshCw className={pulling ? "size-4 animate-spin" : "size-4"} />} disabled={pulling} onClick={onUpdate}>
                    {t("selfMedia.update")}
                </Button>
            </div>
        </div>
    );
}

function StatCard({ icon, label, value, hint, live }: { icon: React.ReactNode; label: string; value: string | number; hint?: string; live?: boolean }) {
    return (
        <div className={`rounded-xl border px-4 py-3 transition-colors ${live ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/30" : "border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900/40"}`}>
            <div className="flex items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                {icon}
                {label}
            </div>
            <div className="mt-1 truncate text-lg font-semibold text-stone-900 dark:text-stone-100" title={String(value)}>
                {value}
            </div>
            {hint ? (
                <div className="truncate text-[11px] text-stone-400 dark:text-stone-500" title={hint}>
                    {hint}
                </div>
            ) : null}
        </div>
    );
}
