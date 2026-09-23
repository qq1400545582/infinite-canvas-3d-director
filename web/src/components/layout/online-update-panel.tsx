import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Tag } from "antd";
import { useTranslation } from "react-i18next";

/**
 * 「在线更新」面板：挂在版本弹窗里，调用本地开发服务提供的 /__online-update/* 接口，
 * 真正执行「检查 → 更新 → 回滚」。所有写入都由 scripts/update-from-upstream.mjs 完成，
 * 二次开发内容由 second-dev/manifest.json 保护。
 *
 * 在非本地开发环境（生产构建）下接口不存在，面板会自动降级为命令行指引，不影响其它功能。
 */

type TaskResult = {
    ok?: boolean;
    mode?: string;
    localVersion?: string | null;
    upstreamVersion?: string | null;
    hasUpdate?: boolean;
    counts?: Record<string, number>;
    conflicts?: Array<{ file: string; reason: string }>;
    assertions?: Array<{ kind: string; target: string; ok: boolean; detail?: string; label?: string }>;
    builds?: Array<{ name: string; ok: boolean; reason?: string }>;
    backupDir?: string | null;
    error?: string;
    rolledBack?: unknown;
};

type StatusPayload = {
    ok: boolean;
    localVersion?: string | null;
    baseVersion?: string | null;
    protectedPaths?: string[];
    desktop?: boolean;
    // 桌面端 /__online-update/status 只返回 {ok,supported,desktop}，没有 task 字段；
    // 必须保持可选并用 status?.task?.x 访问，否则会在 effect 中抛
    // "Cannot read properties of undefined (reading 'running')" 把整个应用打挂。
    task?: {
        running: boolean;
        mode: string | null;
        finishedAt: number;
        error: string | null;
        result: TaskResult | null;
        lines: string[];
    };
};

const ENDPOINT = "/__online-update";

export function OnlineUpdatePanel() {
    const { t } = useTranslation();
    const [status, setStatus] = useState<StatusPayload | null>(null);
    const [available, setAvailable] = useState<boolean | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<number | null>(null);

    const refresh = useCallback(async () => {
        try {
            const response = await fetch(`${ENDPOINT}/status`, { headers: { Accept: "application/json" } });
            const contentType = response.headers.get("content-type") || "";
            if (!response.ok || !contentType.includes("application/json")) throw new Error("unsupported");
            const payload = (await response.json()) as StatusPayload;
            setStatus(payload);
            setAvailable(true);
            return payload;
        } catch {
            setAvailable(false);
            return null;
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // 任务进行中时轮询进度
    useEffect(() => {
        if (!status?.task?.running) {
            if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
            return;
        }
        timerRef.current = window.setTimeout(() => void refresh(), 1200);
        return () => {
            if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
        };
    }, [status, refresh]);

    const start = useCallback(
        async (action: "check" | "apply" | "rollback") => {
            setError(null);
            try {
                const response = await fetch(`${ENDPOINT}/${action}`, { method: "POST" });
                const payload = (await response.json()) as { ok: boolean; error?: string };
                if (!payload.ok) setError(payload.error || t("version.online.failed"));
                await refresh();
            } catch {
                setError(t("version.online.failed"));
            }
        },
        [refresh, t],
    );

    if (available === false) {
        return (
            <div className="mt-4 rounded-lg border border-dashed border-stone-200 p-3 text-xs leading-6 text-stone-500 dark:border-stone-800 dark:text-stone-400">
                <div className="mb-1 font-medium text-stone-700 dark:text-stone-200">{t("version.online.title")}</div>
                {t("version.online.devOnly")}
                <div className="mt-1">
                    <code className="rounded bg-stone-100 px-1 py-0.5 text-[11px] text-stone-700 dark:bg-stone-800 dark:text-stone-200">
                        node scripts/update-from-upstream.mjs --apply
                    </code>
                </div>
            </div>
        );
    }

    // 桌面端：本机服务返回 supported:false + desktop:true，更新改用「三层更新」面板。
    if (status?.desktop) {
        return (
            <div className="mt-4 rounded-lg border border-stone-200 p-3 text-xs leading-6 text-stone-500 dark:border-stone-800 dark:text-stone-400">
                <div className="mb-1 font-medium text-stone-700 dark:text-stone-200">{t("version.online.title")}</div>
                {t("version.online.desktopNote")}
            </div>
        );
    }

    const task = status?.task;
    const result = task?.result || null;
    const busy = Boolean(task?.running);
    const localVersion = status?.localVersion || "—";
    const upstreamVersion = result?.upstreamVersion || null;
    const hasUpdate = Boolean(result?.hasUpdate);

    const counts = result?.counts || {};
    const assertions = result?.assertions || [];
    const failedAssertions = assertions.filter((item) => !item.ok);
    const conflictCount = result?.conflicts?.length || 0;

    return (
        <div className="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-stone-700 dark:text-stone-200">{t("version.online.title")}</span>
                    {result ? (
                        hasUpdate ? (
                            <Tag color="green" className="m-0">
                                {t("version.online.available", { version: upstreamVersion })}
                            </Tag>
                        ) : (
                            <Tag className="m-0">{t("version.online.upToDate")}</Tag>
                        )
                    ) : null}
                </div>
                <div className="flex items-center gap-2">
                    <Button size="small" disabled={busy} onClick={() => void start("check")} loading={busy && task?.mode === "check"}>
                        {t("version.online.check")}
                    </Button>
                    <Button size="small" type="primary" disabled={busy} onClick={() => void start("apply")} loading={busy && task?.mode === "apply"}>
                        {t("version.online.apply")}
                    </Button>
                    <Button size="small" danger disabled={busy} onClick={() => void start("rollback")} loading={busy && task?.mode === "rollback"}>
                        {t("version.online.rollback")}
                    </Button>
                </div>
            </div>

            <div className="mt-2 text-[11px] leading-5 text-stone-500 dark:text-stone-400">
                {t("version.online.protectedHint", { count: status?.protectedPaths?.length || 0 })}
                {status?.baseVersion ? ` · ${t("version.online.baseVersion", { version: status.baseVersion })}` : ""}
            </div>

            {error ? <div className="mt-2 text-[11px] text-red-500">{error}</div> : null}
            {task?.error ? <div className="mt-2 text-[11px] text-red-500">{task.error}</div> : null}
            {result?.error ? <div className="mt-2 text-[11px] text-red-500">{result.error}</div> : null}

            {result && !result.error ? (
                <div className="mt-3 space-y-1.5 text-[11px] leading-5 text-stone-600 dark:text-stone-300">
                    {result.mode === "rollback" ? (
                        <div>{t("version.online.rolledBack")}</div>
                    ) : (
                        <>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                                <span>{t("version.online.impactOverwrite")}：{counts.write ?? 0}</span>
                                <span>{t("version.online.impactAdd")}：{counts.add ?? 0}</span>
                                <span>{t("version.online.impactMerge")}：{counts.merge ?? 0}</span>
                                <span>{t("version.online.impactKeepLocal")}：{counts.keepLocal ?? 0}</span>
                                <span className="text-green-600 dark:text-green-400">
                                    {t("version.online.impactSkipped")}：{counts.skipped ?? 0}
                                </span>
                            </div>
                            {assertions.length ? (
                                <div className={failedAssertions.length ? "text-red-500" : "text-green-600 dark:text-green-400"}>
                                    {failedAssertions.length
                                        ? t("version.online.verifyFailed", { count: failedAssertions.length })
                                        : t("version.online.verifyPassed", { passed: assertions.length, total: assertions.length })}
                                </div>
                            ) : null}
                            {conflictCount ? <div className="text-amber-600 dark:text-amber-400">{t("version.online.conflicts", { count: conflictCount })}</div> : null}
                            {result.builds?.length ? (
                                <div>
                                    {result.builds.map((build) => (
                                        <span key={build.name} className={build.ok ? "mr-3 text-green-600 dark:text-green-400" : "mr-3 text-red-500"}>
                                            {build.ok ? "✓" : "✗"} {build.name}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                            {result.mode === "apply" && result.ok ? (
                                <div className="text-amber-600 dark:text-amber-400">{t("version.online.restartHint")}</div>
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}

            {busy && task?.lines?.length ? (
                <div className="mt-2 max-h-24 overflow-y-auto rounded bg-stone-50 p-2 text-[10px] leading-4 text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                    {task.lines.slice(-8).map((line, index) => (
                        <div key={`${index}-${line.slice(0, 12)}`} className="truncate">
                            {line}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
