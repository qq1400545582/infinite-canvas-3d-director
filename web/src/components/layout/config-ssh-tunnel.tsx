import { saveAs } from "file-saver";
import { App, Button, Form, Input, Switch } from "antd";
import { Copy, FileCode2, Link2, ShieldCheck, TerminalSquare, Wifi } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import {
    buildSshTunnelScriptFile,
    probeLocalPort,
    sshTunnelLocalUrl,
    sshTunnelPreviewCommand,
    sshTunnelVerifyCommand,
    validateSshTunnelConfig,
    type SshTunnelFieldError,
} from "@/services/ssh-tunnel";
import { useSshTunnelStore, type SshTunnelConfig } from "@/stores/use-ssh-tunnel-store";

const FIELD_LABEL: Record<SshTunnelFieldError, string> = {
    sshHost: "sshHost",
    sshUser: "sshUser",
    sshPort: "sshPort",
    localPort: "localPort",
    targetHost: "targetHost",
    targetPort: "targetPort",
    keepAliveInterval: "keepAliveInterval",
    keepAliveCountMax: "keepAliveCountMax",
    retryDelay: "retryDelay",
};

/**
 * 「SSH 远程连接」：把远端 API 端口通过持久 SSH 隧道映射到本机端口。
 *
 * 本机进程由生成的自动化脚本负责拉起（autossh 优先、ssh 监督循环兜底），
 * 保活参数（ServerAlive 心跳 + 心跳阈值 + 重连间隔）在这里配置并写入脚本；
 * 本面板只负责配置、脚本生成与本机端口探测，不触碰其它模块。
 */
export function ConfigSshTunnel() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const tunnel = useSshTunnelStore((state) => state.tunnel);
    const updateTunnel = useSshTunnelStore((state) => state.updateTunnel);
    const [testing, setTesting] = useState(false);
    const errors = validateSshTunnelConfig(tunnel);
    const ready = errors.length === 0;
    const preview = sshTunnelPreviewCommand(tunnel);
    const localUrl = sshTunnelLocalUrl(tunnel);
    const insecureContext = typeof window !== "undefined" && window.location.protocol === "https:";

    const field = (key: keyof SshTunnelConfig, options?: { placeholder?: string; hint?: string }) => {
        const invalid = (errors as string[]).includes(key);
        return (
            <Form.Item
                label={t(`config.tunnel.${FIELD_LABEL[key as SshTunnelFieldError] ?? key}`)}
                extra={options?.hint}
                validateStatus={invalid ? "error" : undefined}
                className="mb-0"
            >
                <Input value={String(tunnel[key])} placeholder={options?.placeholder} onChange={(event) => updateTunnel(key, event.target.value as SshTunnelConfig[typeof key])} />
            </Form.Item>
        );
    };

    const download = (kind: "ps1" | "sh") => {
        if (!ready) {
            message.error(t("config.tunnel.missing", { fields: errors.map((error) => t(`config.tunnel.${FIELD_LABEL[error]}`)).join("、") }));
            return;
        }
        const { name, content } = buildSshTunnelScriptFile(kind, tunnel);
        saveAs(new Blob([content], { type: "text/plain;charset=utf-8" }), name);
        message.success(t("config.tunnel.scriptReady", { name }));
    };

    const testTunnel = async () => {
        setTesting(true);
        try {
            const online = await probeLocalPort(tunnel.localPort);
            if (online) message.success(t("config.tunnel.testOnline", { url: localUrl }));
            else message.warning(t("config.tunnel.testOffline", { port: tunnel.localPort.trim() }));
        } finally {
            setTesting(false);
        }
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Link2 className="size-4" />
                            {t("config.tunnel.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.tunnel.description")}</div>
                    </div>
                    <Switch checked={tunnel.enabled} onChange={(checked) => updateTunnel("enabled", checked)} />
                </div>

                {tunnel.enabled ? (
                    <div className="mt-3 flex flex-col gap-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {field("sshHost", { placeholder: t("config.tunnel.sshHostPlaceholder") })}
                            {field("sshPort", { placeholder: "22" })}
                            {field("sshUser", { placeholder: t("config.tunnel.sshUserPlaceholder") })}
                            {field("identityFile", { placeholder: t("config.tunnel.identityFilePlaceholder"), hint: t("config.tunnel.identityFileHint") })}
                            {field("localPort", { placeholder: "18787" })}
                            {field("targetHost", { placeholder: "127.0.0.1" })}
                            {field("targetPort", { placeholder: "8000" })}
                            {field("retryDelay", { hint: t("config.tunnel.unitsSeconds") })}
                            {field("keepAliveInterval", { hint: t("config.tunnel.unitsSeconds") })}
                            {field("keepAliveCountMax", { hint: t("config.tunnel.unitsTimes") })}
                        </div>

                        <div className="flex items-center gap-2 text-xs text-stone-500">
                            <ShieldCheck className="size-3.5" />
                            {t("config.tunnel.keepAliveHint", {
                                interval: tunnel.keepAliveInterval.trim(),
                                count: tunnel.keepAliveCountMax.trim(),
                                delay: tunnel.retryDelay.trim(),
                            })}
                        </div>

                        <div className="rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-900">
                            <div className="mb-1 text-xs text-stone-500">{t("config.tunnel.preview")}</div>
                            <div className="flex items-center justify-between gap-3">
                                <code className="min-w-0 truncate text-xs">{preview}</code>
                                <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(preview)} />
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <Button icon={<FileCode2 className="size-4" />} onClick={() => download("ps1")}>
                                {t("config.tunnel.downloadWindows")}
                            </Button>
                            <Button icon={<TerminalSquare className="size-4" />} onClick={() => download("sh")}>
                                {t("config.tunnel.downloadUnix")}
                            </Button>
                            <Button icon={<Wifi className="size-4" />} loading={testing} onClick={() => void testTunnel()}>
                                {t("config.tunnel.test")}
                            </Button>
                        </div>

                        <div className="flex items-center justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                            <div className="text-xs text-stone-500">{t("config.tunnel.autoStart")}</div>
                            <Switch size="small" checked={tunnel.autoStart} onChange={(checked) => updateTunnel("autoStart", checked)} />
                        </div>

                        <div className="text-xs text-stone-500">{t("config.tunnel.scriptHint", { autostart: tunnel.autoStart ? t("config.tunnel.autoStartOn") : t("config.tunnel.autoStartOff") })}</div>

                        <div className="flex items-center gap-2 text-xs text-stone-500">
                            <span>{t("config.tunnel.usageHint", { url: localUrl })}</span>
                            <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(localUrl)} />
                        </div>

                        {insecureContext ? (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                                <span>{t("config.tunnel.insecureHint")}</span>
                                <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(sshTunnelVerifyCommand(tunnel))}>
                                    {t("config.tunnel.copyVerify")}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </section>
        </Form>
    );
}
