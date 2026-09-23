import { useEffect, useState } from "react";
import { Button, Tooltip, message } from "antd";
import { MonitorDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DESKTOP_RELEASES_PAGE_URL, prefetchDesktopDownloadUrl, resolveDesktopDownloadUrl, triggerDesktopDownload } from "@/constant/desktop-download";

/**
 * 导航栏「下载桌面端」入口：点击直接下载安装包。
 * 安装包地址由 constant/desktop-download.ts 按当前环境解析（环境变量 > 最新 Release > 发布页兜底）。
 * 桌面壳内不渲染（已经在用桌面端）。
 */
export function DesktopDownloadButton() {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const inDesktopShell = typeof window !== "undefined" && Boolean(window.__INFINITE_CANVAS_DESKTOP__);

    // 页面挂载后预热地址解析，点击时通常已就绪。
    useEffect(() => {
        if (!inDesktopShell) prefetchDesktopDownloadUrl();
    }, [inDesktopShell]);

    if (inDesktopShell) return null;

    const label = t("topNav.downloadDesktop");

    const handleClick = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const url = await resolveDesktopDownloadUrl();
            if (url) {
                triggerDesktopDownload(url);
                return;
            }
            // 没有可用直链（例如还没发布过 Release）时不能给死链：打开发布页并说明原因。
            window.open(DESKTOP_RELEASES_PAGE_URL, "_blank", "noopener,noreferrer");
            message.info(t("topNav.downloadDesktopFallback"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Tooltip title={label}>
            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" loading={busy} icon={<MonitorDown className="size-4" />} onClick={() => void handleClick()} aria-label={label} />
        </Tooltip>
    );
}
