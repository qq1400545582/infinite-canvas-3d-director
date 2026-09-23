import { useEffect, useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";

import { APP_VERSION } from "@/constant/env";

const SEEN_KEY = "infinite-canvas:plugin-onboarding-seen";

// 4 个自研插件的展示顺序（id 与插件自身的 PLUGIN_ID 一致，用于将来联动插件面板）。
const PLUGIN_IDS = ["clipshot", "director-desk", "jlmlh-3d-director", "openreel-video"] as const;

const PLUGIN_I18N_KEY: Record<(typeof PLUGIN_IDS)[number], "clipshot" | "directorDesk" | "jlmlh" | "openreel"> = {
    clipshot: "clipshot",
    "director-desk": "directorDesk",
    "jlmlh-3d-director": "jlmlh",
    "openreel-video": "openreel",
};

/**
 * 首次进入画布的引导弹窗（P1c）：告知用户 4 个自研插件已默认启用。
 * 只在从未看过（localStorage 标记）时出现一次，不干扰已有用户。
 */
export function PluginOnboardingModal() {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let seen = false;
        try {
            seen = localStorage.getItem(SEEN_KEY) === "1";
        } catch {
            seen = false;
        }
        if (!seen) setOpen(true);
    }, []);

    const dismiss = () => {
        try {
            localStorage.setItem(SEEN_KEY, "1");
        } catch {
            /* 忽略：隐私模式等场景下 localStorage 不可用 */
        }
        setOpen(false);
    };

    return (
        <Modal
            title={t("onboarding.title")}
            open={open}
            width={560}
            centered
            footer={
                <button
                    type="button"
                    className="cursor-pointer rounded-md bg-stone-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                    onClick={dismiss}
                >
                    {t("onboarding.gotIt")}
                </button>
            }
            onCancel={dismiss}
            maskClosable={false}
        >
            <div className="space-y-3">
                <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">{t("onboarding.desc")}</p>
                <ul className="space-y-2">
                    {PLUGIN_IDS.map((id) => (
                        <li key={id} className="rounded-lg border border-stone-200 px-3 py-2 text-sm leading-5 text-stone-700 dark:border-stone-800 dark:text-stone-200">
                            {t(`onboarding.plugin.${PLUGIN_I18N_KEY[id]}`)}
                        </li>
                    ))}
                </ul>
                <p className="text-xs leading-5 text-stone-400 dark:text-stone-500">{t("onboarding.enabledNote")}</p>
                <p className="text-[11px] leading-4 text-stone-300 dark:text-stone-600">v{APP_VERSION}</p>
            </div>
        </Modal>
    );
}
