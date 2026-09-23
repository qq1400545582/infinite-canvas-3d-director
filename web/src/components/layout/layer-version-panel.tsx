import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

// 仅桌面壳注入此标志（desktop/src/preload.ts）。网页版（CF Pages）无此标志 → 本组件直接返回 null，零行为变化。
declare global {
    interface Window {
        __INFINITE_CANVAS_DESKTOP__?: boolean;
    }
}

// 所有嵌套分组都设为可选：任何一层缺失（旧壳版本、接口降级、字段变更）都只降级展示，
// 绝不能在渲染/effect 中抛错——本组件位于版本弹窗内，抛错会连带整个应用一起崩。
type LayerStatus = {
    ok?: boolean;
    configured?: boolean;
    manifestUrl?: string;
    manifestFromEnv?: boolean;
    shell?: { version?: string; update?: { available: boolean; downloaded: boolean; version: string | null } | null };
    frontend?: { builtinVersion?: string | null; overlayVersion?: string | null };
    remote?: { version?: string | null; baseUrl?: string | null; changed?: number };
    task?: { running?: boolean; mode?: "check" | "apply" | null; error?: string | null; finishedAt?: number };
};

const ENDPOINT = "/__layer-update";

/**
 * 三层更新面板（P3c）：仅在桌面壳内渲染。展示 插件 / 前端 / 桌面壳 三段式状态，
 * 并提供「更新源」配置 + 「检查前端更新 / 应用前端更新 / 重启安装壳更新」操作。
 * 网页版不会渲染本组件（window.__INFINITE_CANVAS_DESKTOP__ 不存在）。
 */
export function LayerVersionPanel() {
    const { t } = useTranslation();
    if (!window.__INFINITE_CANVAS_DESKTOP__) return null;

    const [status, setStatus] = useState<LayerStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 更新源（远程 build-manifest.json 地址）：未配置时按钮不可用，避免直接抛「未配置」红字。
    const [urlDraft, setUrlDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [savedTick, setSavedTick] = useState(0);
    const timerRef = useRef<number | null>(null);
    const dirtyRef = useRef(false);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`${ENDPOINT}/status`, { headers: { Accept: "application/json" } });
            if (!res.ok) return;
            const payload = (await res.json()) as LayerStatus;
            setStatus(payload);
            // 只在用户没在编辑时回填输入框，避免轮询把正在输入的内容冲掉
            if (!dirtyRef.current && typeof payload.manifestUrl === "string") setUrlDraft(payload.manifestUrl);
            return payload;
        } catch {
            return null;
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (status?.task?.running) {
            timerRef.current = window.setTimeout(() => void refresh(), 1200);
            return () => {
                if (timerRef.current) window.clearTimeout(timerRef.current);
            };
        }
        return undefined;
    }, [status, refresh]);

    const saveSource = useCallback(async () => {
        setSaving(true);
        setSaveError(null);
        try {
            const res = await fetch(`${ENDPOINT}/config`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ manifestUrl: urlDraft.trim() }),
            });
            const payload = (await res.json()) as { ok?: boolean; error?: string; manifestUrl?: string };
            if (!res.ok || !payload.ok) {
                setSaveError(payload.error === "invalid-url" ? t("version.layer.invalidUrl") : payload.error || t("version.online.failed"));
                return;
            }
            dirtyRef.current = false;
            if (typeof payload.manifestUrl === "string") setUrlDraft(payload.manifestUrl);
            setSavedTick(Date.now());
        } catch {
            setSaveError(t("version.online.failed"));
        } finally {
            setSaving(false);
            await refresh();
        }
    }, [refresh, t, urlDraft]);

    const run = useCallback(
        async (action: "check" | "apply") => {
            setBusy(true);
            setError(null);
            try {
                const res = await fetch(`${ENDPOINT}/${action}`, { method: "POST" });
                if (!res.ok) {
                    const payload = (await res.json().catch(() => ({}))) as { error?: string };
                    setError(payload.error === "not-configured" ? t("version.layer.needSource") : payload.error || t("version.online.failed"));
                }
            } catch {
                setError(t("version.online.failed"));
            } finally {
                setBusy(false);
            }
            await refresh();
        },
        [refresh, t],
    );

    const installShell = useCallback(async () => {
        try {
            await fetch(`${ENDPOINT}/install-shell`, { method: "POST" });
        } catch {
            /* 进程会重启，忽略 */
        }
    }, []);

    // 统一在这里收敛默认值，JSX 里不再做多级属性访问（避免任何一层缺失时抛错）。
    const shellUpdate = status?.shell?.update ?? null;
    const shellVersion = status?.shell?.version || "—";
    const frontendVersion = status?.frontend?.overlayVersion || status?.frontend?.builtinVersion || "—";
    const remoteVersion = status?.remote?.version ?? null;
    const remoteChanged = status?.remote?.changed ?? 0;
    const task = status?.task ?? null;
    const configured = Boolean(status?.configured);
    const fromEnv = Boolean(status?.manifestFromEnv);
    const taskError = task?.error ?? null;
    const applied = Boolean(task?.finishedAt) && !task?.running && task?.mode === "apply" && !taskError;

    return (
        <div className="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="text-xs font-medium text-stone-700 dark:text-stone-200">{t("version.layer.title")}</div>
            <div className="mt-1 text-[11px] leading-5 text-stone-500 dark:text-stone-400">{t("version.layer.desktopNote")}</div>

            <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-md border border-stone-100 px-2.5 py-1.5 dark:border-stone-800">
                    <span className="text-xs text-stone-600 dark:text-stone-300">{t("version.layer.plugins")}</span>
                    <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("version.layer.upToDate")}</span>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-md border border-stone-100 px-2.5 py-1.5 dark:border-stone-800">
                    <span className="text-xs text-stone-600 dark:text-stone-300">{t("version.layer.frontend")}</span>
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">
                        {t("version.layer.current", { version: frontendVersion })}
                        {" · "}
                        {configured ? <>{t("version.layer.remote", { version: remoteVersion || "—" })}</> : t("version.layer.noRemote")}
                    </span>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-md border border-stone-100 px-2.5 py-1.5 dark:border-stone-800">
                    <span className="text-xs text-stone-600 dark:text-stone-300">{t("version.layer.shell")}</span>
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">
                        {t("version.layer.current", { version: shellVersion })}
                        {shellUpdate?.available ? (
                            <span className="ml-1 text-amber-600 dark:text-amber-400">
                                {shellUpdate.downloaded ? t("version.layer.shellDownloaded") : t("version.layer.shellAvailable", { version: shellUpdate.version || "" })}
                            </span>
                        ) : null}
                    </span>
                </div>
            </div>

            {/* 更新源：未配置时按钮禁用并给出中性指引，而不是在点下去之后抛一段红字错误。 */}
            <div className="mt-3 rounded-md border border-stone-100 px-2.5 py-2 dark:border-stone-800">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">{t("version.layer.source")}</span>
                    {fromEnv ? <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("version.layer.sourceFromEnv")}</span> : null}
                </div>
                {fromEnv ? (
                    <div className="mt-1.5 truncate text-[11px] text-stone-500 dark:text-stone-400" title={urlDraft}>
                        {urlDraft}
                    </div>
                ) : (
                    <div className="mt-1.5 flex items-center gap-2">
                        <input
                            value={urlDraft}
                            onChange={(event) => {
                                dirtyRef.current = true;
                                setUrlDraft(event.target.value);
                                setSaveError(null);
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") void saveSource();
                            }}
                            placeholder={t("version.layer.sourcePlaceholder")}
                            spellCheck={false}
                            className="min-w-0 flex-1 rounded-md border border-stone-200 bg-transparent px-2 py-1 text-[11px] text-stone-700 outline-none placeholder:text-stone-400 focus:border-stone-400 dark:border-stone-700 dark:text-stone-200 dark:placeholder:text-stone-500 dark:focus:border-stone-500"
                        />
                        <Button size="small" onClick={() => void saveSource()} loading={saving}>
                            {t("version.layer.saveSource")}
                        </Button>
                    </div>
                )}
                <div className="mt-1.5 text-[11px] leading-5 text-stone-400 dark:text-stone-500">
                    {savedTick && !saveError ? <span className="mr-1 text-green-600 dark:text-green-400">{t("version.layer.sourceSaved")}</span> : null}
                    {saveError ? <span className="mr-1 text-red-500">{saveError}</span> : null}
                    {!configured ? t("version.layer.sourceHint") : null}
                </div>
            </div>

            {remoteVersion && remoteChanged > 0 ? (
                <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t("version.layer.changed", { count: remoteChanged })}</div>
            ) : null}

            {error ? <div className="mt-2 text-[11px] text-red-500">{error}</div> : null}
            {taskError ? <div className="mt-2 text-[11px] text-red-500">{taskError}</div> : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="small" disabled={busy || !configured} onClick={() => void run("check")} loading={busy && task?.mode === "check"}>
                    {t("version.layer.check")}
                </Button>
                <Button size="small" type="primary" disabled={busy || !configured} onClick={() => void run("apply")} loading={busy && task?.mode === "apply"}>
                    {t("version.layer.apply")}
                </Button>
                {shellUpdate?.downloaded ? (
                    <Button size="small" danger onClick={() => void installShell()}>
                        {t("version.layer.installShell")}
                    </Button>
                ) : null}
            </div>

            {applied ? <div className="mt-2 text-[11px] text-green-600 dark:text-green-400">{t("version.layer.applied")}</div> : null}
        </div>
    );
}
