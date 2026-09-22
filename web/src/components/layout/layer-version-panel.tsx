import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Tag } from "antd";
import { useTranslation } from "react-i18next";

// 仅桌面壳注入此标志（desktop/src/preload.ts）。网页版（CF Pages）无此标志 → 本组件直接返回 null，零行为变化。
declare global {
    interface Window {
        __INFINITE_CANVAS_DESKTOP__?: boolean;
    }
}

type LayerStatus = {
    ok: boolean;
    configured: boolean;
    shell: { version: string; update: { available: boolean; downloaded: boolean; version: string | null } | null };
    frontend: { builtinVersion: string | null; overlayVersion: string | null };
    remote: { version: string | null; baseUrl: string | null; changed: number };
    task: { running: boolean; mode: "check" | "apply" | null; error: string | null; finishedAt: number };
};

const ENDPOINT = "/__layer-update";

/**
 * 三层更新面板（P3c）：仅在桌面壳内渲染。展示 插件 / 前端 / 桌面壳 三段式状态，
 * 并提供「检查前端更新 / 应用前端更新 / 重启安装壳更新」操作。
 * 网页版不会渲染本组件（window.__INFINITE_CANVAS_DESKTOP__ 不存在）。
 */
export function LayerVersionPanel() {
    const { t } = useTranslation();
    if (!window.__INFINITE_CANVAS_DESKTOP__) return null;

    const [status, setStatus] = useState<LayerStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<number | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`${ENDPOINT}/status`, { headers: { Accept: "application/json" } });
            if (!res.ok) return;
            const payload = (await res.json()) as LayerStatus;
            setStatus(payload);
            return payload;
        } catch {
            return null;
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (status?.task.running) {
            timerRef.current = window.setTimeout(() => void refresh(), 1200);
            return () => {
                if (timerRef.current) window.clearTimeout(timerRef.current);
            };
        }
        return undefined;
    }, [status, refresh]);

    const run = useCallback(
        async (action: "check" | "apply") => {
            setBusy(true);
            setError(null);
            try {
                await fetch(`${ENDPOINT}/${action}`, { method: "POST" });
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

    const shellUpdate = status?.shell.update;
    const frontendVersion = status?.frontend.overlayVersion || status?.frontend.builtinVersion || "—";

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
                        {status?.configured ? (
                            status.remote.version ? (
                                t("version.layer.remote", { version: status.remote.version })
                            ) : (
                                t("version.layer.remote", { version: "—" })
                            )
                        ) : (
                            t("version.layer.noRemote")
                        )}
                    </span>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-md border border-stone-100 px-2.5 py-1.5 dark:border-stone-800">
                    <span className="text-xs text-stone-600 dark:text-stone-300">{t("version.layer.shell")}</span>
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">
                        {t("version.layer.current", { version: status?.shell.version || "—" })}
                        {shellUpdate?.available ? (
                            <span className="ml-1 text-amber-600 dark:text-amber-400">
                                {shellUpdate.downloaded ? t("version.layer.shellDownloaded") : t("version.layer.shellAvailable", { version: shellUpdate.version || "" })}
                            </span>
                        ) : null}
                    </span>
                </div>
            </div>

            {!status?.configured ? (
                <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t("version.layer.notConfigured")}</div>
            ) : null}

            {status?.remote.version && status.remote.changed > 0 ? (
                <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t("version.layer.changed", { count: status.remote.changed })}</div>
            ) : null}

            {error ? <div className="mt-2 text-[11px] text-red-500">{error}</div> : null}
            {status?.task.error ? <div className="mt-2 text-[11px] text-red-500">{status.task.error}</div> : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="small" disabled={busy} onClick={() => void run("check")} loading={busy && status?.task.mode === "check"}>
                    {t("version.layer.check")}
                </Button>
                <Button size="small" type="primary" disabled={busy} onClick={() => void run("apply")} loading={busy && status?.task.mode === "apply"}>
                    {t("version.layer.apply")}
                </Button>
                {shellUpdate?.downloaded ? (
                    <Button size="small" danger onClick={() => void installShell()}>
                        {t("version.layer.installShell")}
                    </Button>
                ) : null}
            </div>

            {status?.task.finishedAt && !status.task.running && status.task.mode === "apply" && !status.task.error ? (
                <div className="mt-2 text-[11px] text-green-600 dark:text-green-400">{t("version.layer.applied")}</div>
            ) : null}
        </div>
    );
}
