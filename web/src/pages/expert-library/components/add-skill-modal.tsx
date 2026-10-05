import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Form, Input, Modal, Spin, Tabs, Tag } from "antd";
import { Check, CircleAlert, FileArchive, FolderUp, GitBranch, Globe, Link2, LoaderCircle, ShieldAlert, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { agentEndpointReachable, ensureAgentTarget, installAgentSkill, listAgentSkills, waitForAgentEndpoint, type AgentTarget } from "../agent-bridge";
import { fetchRemoteSkills, parseLocalSkills, parseRemoteSource, riskScan, type RemoteErrorCode, type SkillParseErrorCode } from "../skill-source";
import { AgentApiError, fetchCodexSkill, updateCodexSkill } from "@/services/api/canvas-agent";
import type { ParsedSkill } from "../data/types";
import { useAgentStore } from "@/stores/use-agent-store";
import { cn } from "@/lib/utils";

export type AddSkillTab = "import" | "create" | "link";

type CreateForm = { name: string; displayName?: string; description: string; instructions: string };

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 「添加技能」弹窗：导入技能（文件 / 文件夹 / ZIP）、创建技能（AI 或手工）、从链接安装
 * （GitHub / Gitee 仓库或直链）。
 *
 * 三条路径最终都通过本机 Canvas Agent 的 SkillStore 真正安装到
 * `<工作空间>/.agents/skills`，与 WorkBuddy 的「添加技能」行为一致。
 */
export function AddSkillModal({
    open,
    initialTab,
    onClose,
    onInstalled,
    onRequireAgent,
}: {
    open: boolean;
    initialTab: AddSkillTab;
    onClose: () => void;
    onInstalled: (skills: ParsedSkill[]) => void;
    onRequireAgent: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const connected = useAgentStore((state) => state.connected);
    const [tab, setTab] = useState<AddSkillTab>(initialTab);
    const [dragging, setDragging] = useState(false);
    const [parsing, setParsing] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [parsed, setParsed] = useState<ParsedSkill[] | null>(null);
    const [failures, setFailures] = useState<{ name: string; code: SkillParseErrorCode }[]>([]);
    const [autoInstall, setAutoInstall] = useState(true);
    const [conflictSkills, setConflictSkills] = useState<ParsedSkill[] | null>(null);
    const [link, setLink] = useState("");
    const [linking, setLinking] = useState(false);
    const [remoteError, setRemoteError] = useState<RemoteErrorCode | null>(null);
    const [aiPrompt, setAiPrompt] = useState("");
    const [saving, setSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const zipInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const [form] = Form.useForm<CreateForm>();

    useEffect(() => {
        if (!open) return;
        setTab(initialTab);
        setDragging(false);
        setParsed(null);
        setFailures([]);
        setRemoteError(null);
        setConflictSkills(null);
        setLink("");
        setAiPrompt("");
        form.resetFields();
    }, [open, initialTab, form]);

    useEffect(() => {
        // 文件夹选择需要非标准属性，React 不提供对应 prop，这里显式设置。
        folderInputRef.current?.setAttribute("webkitdirectory", "");
        folderInputRef.current?.setAttribute("directory", "");
    }, [open]);

    const describeInstallError = (error: unknown) => (error instanceof Error ? error.message : t("expertLibrary.addSkill.installFailed"));

    const install = async (skills: ParsedSkill[], silent = false) => {
        if (!skills.length) return;
        const target: AgentTarget | null = await ensureAgentTarget();
        if (!target) {
            onRequireAgent();
            return;
        }
        // 未连接时先探测本机 Agent：它可能正在启动中（冷启动需数秒），短暂等待；
        // 确实不可达则引导去连接，而不是让安装请求裸报 “Failed to fetch”。
        if (!connected && !(await agentEndpointReachable(target.endpoint))) {
            if (!silent) message.info(t("expertLibrary.addSkill.agentWaiting"));
            if (!(await waitForAgentEndpoint(target.endpoint))) {
                message.error(t("expertLibrary.addSkill.agentUnreachable", { endpoint: target.endpoint }));
                onRequireAgent();
                return;
            }
        }
        setInstalling(true);
        const done: ParsedSkill[] = [];
        const failed: string[] = [];
        const conflicts: ParsedSkill[] = [];
        for (const skill of skills) {
            try {
                await installAgentSkill(target, {
                    name: skill.name,
                    description: skill.description,
                    instructions: skill.instructions,
                    ...(skill.interface ? { interface: skill.interface } : {}),
                });
                done.push(skill);
            } catch (error) {
                // 409 = 本机已有同名技能（内容 / 功能可能不同），交给用户选择覆盖或换名，不算安装失败。
                if (error instanceof AgentApiError && error.status === 409) conflicts.push(skill);
                else failed.push(`${skill.name}：${describeInstallError(error)}`);
            }
        }
        setInstalling(false);
        if (done.length) {
            onInstalled(done);
            if (!silent) message.success(t("expertLibrary.addSkill.installed", { count: done.length }));
        }
        if (failed.length) {
            message.error(t("expertLibrary.addSkill.installPartial", { failed: failed.join("；") }));
        }
        if (conflicts.length) {
            setConflictSkills(conflicts);
            return;
        }
        if (done.length && !failed.length) {
            setParsed(null);
            onClose();
        }
    };

    /** 同名冲突解决：overwrite = 带 revision 覆盖现有技能；rename = 自动加 -2~-9 后缀换名安装。 */
    const resolveConflicts = async (mode: "overwrite" | "rename") => {
        const skills = conflictSkills || [];
        setConflictSkills(null);
        if (!skills.length) return;
        const target: AgentTarget | null = await ensureAgentTarget();
        if (!target) {
            onRequireAgent();
            return;
        }
        setInstalling(true);
        const done: ParsedSkill[] = [];
        const failed: string[] = [];
        if (mode === "overwrite") {
            for (const skill of skills) {
                try {
                    const detail = await fetchCodexSkill(target.endpoint, target.token, skill.name);
                    await updateCodexSkill(target.endpoint, target.token, skill.name, {
                        description: skill.description,
                        instructions: skill.instructions,
                        ...(skill.interface ? { interface: skill.interface } : {}),
                        expectedRevision: detail.data?.revision || "",
                    });
                    done.push(skill);
                } catch (error) {
                    failed.push(`${skill.name}：${describeInstallError(error)}`);
                }
            }
        } else {
            const existing = new Set(((await listAgentSkills()) || []).map((skill) => skill.name.toLowerCase()));
            for (const skill of skills) {
                let installed = false;
                let lastError = "";
                for (let suffix = 2; suffix <= 9 && !installed; suffix++) {
                    const candidate = `${skill.name}-${suffix}`.slice(0, 64);
                    if (existing.has(candidate)) continue;
                    try {
                        await installAgentSkill(target, {
                            name: candidate,
                            description: skill.description,
                            instructions: skill.instructions,
                            ...(skill.interface ? { interface: skill.interface } : {}),
                        });
                        existing.add(candidate);
                        done.push({ ...skill, name: candidate });
                        installed = true;
                    } catch (error) {
                        if (error instanceof AgentApiError && error.status === 409) continue;
                        lastError = describeInstallError(error);
                        break;
                    }
                }
                if (!installed) failed.push(`${skill.name}：${lastError || t("expertLibrary.addSkill.conflictNoName")}`);
            }
        }
        setInstalling(false);
        if (done.length) {
            onInstalled(done);
            message.success(t("expertLibrary.addSkill.installed", { count: done.length }));
        }
        if (failed.length) {
            message.error(t("expertLibrary.addSkill.installPartial", { failed: failed.join("；") }));
        }
        if (done.length && !failed.length) {
            setParsed(null);
            onClose();
        }
    };

    const handleFiles = async (files: File[]) => {
        if (!files.length) return;
        setParsing(true);
        setRemoteError(null);
        const outcome = await parseLocalSkills(files);
        setParsing(false);
        setParsed(outcome.skills);
        setFailures(outcome.failures);
        if (!outcome.skills.length) {
            message.warning(t("expertLibrary.addSkill.noParseResult"));
            return;
        }
        const safe = autoInstall ? outcome.skills.filter((skill) => !skill.risky) : [];
        if (safe.length) {
            message.info(t("expertLibrary.addSkill.autoInstalling", { count: safe.length }));
            void install(safe, true);
        }
    };

    const handleRemote = async () => {
        const source = parseRemoteSource(link);
        if ("error" in source) {
            setRemoteError(source.error);
            return;
        }
        setLinking(true);
        setRemoteError(null);
        setParsed(null);
        const result = await fetchRemoteSkills(source);
        setLinking(false);
        if ("error" in result) {
            setRemoteError(result.error);
            return;
        }
        setParsed(result.skills);
        setFailures([]);
        message.success(t("expertLibrary.addSkill.remoteFound", { count: result.skills.length }));
    };

    const handleManualCreate = async () => {
        let values: CreateForm;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const description = values.description.trim();
        const risk = riskScan({ name: values.name.trim(), description, instructions: values.instructions });
        setSaving(true);
        await install([
            {
                name: values.name.trim(),
                description,
                instructions: values.instructions.trim(),
                ...(values.displayName?.trim() ? { interface: { displayName: values.displayName.trim() } } : {}),
                origin: t("expertLibrary.addSkill.originManual"),
                risky: risk.risky,
                riskReasons: risk.reasons,
            },
        ]);
        setSaving(false);
    };

    const handleAiCreate = () => {
        const requirement = aiPrompt.trim();
        const agent = useAgentStore.getState();
        agent.openPanel();
        agent.setAgentState({
            prompt: t("expertLibrary.addSkill.aiPrompt", { requirement: requirement || t("expertLibrary.addSkill.aiPlaceholder") }),
            activeTab: "chat",
        });
        if (!connected) onRequireAgent();
    };

    const safeCount = (parsed || []).filter((skill) => !skill.risky).length;
    const riskyCount = (parsed || []).length - safeCount;

    return (
        <Modal
            title={t("expertLibrary.addSkill.title")}
            open={open}
            onCancel={() => (installing || saving ? undefined : onClose())}
            footer={null}
            width={620}
            centered
            destroyOnHidden
        >
            {!connected ? (
                <Alert
                    className="mb-4"
                    type="warning"
                    showIcon
                    message={t("expertLibrary.addSkill.needAgentTitle")}
                    description={t("expertLibrary.addSkill.needAgentDesc")}
                    action={
                        <Button size="small" type="primary" onClick={onRequireAgent}>
                            {t("expertLibrary.addSkill.connectAgent")}
                        </Button>
                    }
                />
            ) : null}

            <Tabs
                activeKey={tab}
                onChange={(key) => {
                    setTab(key as AddSkillTab);
                    setParsed(null);
                    setFailures([]);
                    setRemoteError(null);
                }}
                items={[
                    {
                        key: "import",
                        label: t("expertLibrary.addSkill.tabImport"),
                        children: (
                            <div className="flex flex-col gap-4 pt-1">
                                <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => fileInputRef.current?.click()}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click();
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        setDragging(true);
                                    }}
                                    onDragLeave={() => setDragging(false)}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        setDragging(false);
                                        void handleFiles(Array.from(event.dataTransfer.files));
                                    }}
                                    className={cn(
                                        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-9 text-center transition",
                                        dragging
                                            ? "border-emerald-400 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-500/10"
                                            : "border-stone-300 bg-stone-50 hover:border-stone-400 dark:border-stone-700 dark:bg-stone-900/40 dark:hover:border-stone-600",
                                    )}
                                >
                                    {parsing ? (
                                        <Spin size="small" />
                                    ) : (
                                        <Upload className="size-6 text-stone-400 dark:text-stone-500" />
                                    )}
                                    <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
                                        {t("expertLibrary.addSkill.dropHint")}
                                    </span>
                                </div>

                                <Checkbox checked={autoInstall} onChange={(event) => setAutoInstall(event.target.checked)}>
                                    <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addSkill.autoInstall")}</span>
                                </Checkbox>

                                <div>
                                    <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">{t("expertLibrary.addSkill.requirements")}</div>
                                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-5 text-stone-500 dark:text-stone-400">
                                        <li>{t("expertLibrary.addSkill.requirement1")}</li>
                                        <li>{t("expertLibrary.addSkill.requirement2")}</li>
                                    </ul>
                                </div>

                                <button
                                    type="button"
                                    className="self-start text-sm text-emerald-600 underline-offset-4 hover:underline dark:text-emerald-400"
                                    onClick={() => zipInputRef.current?.click()}
                                >
                                    {t("expertLibrary.addSkill.chooseZip")}
                                </button>
                                <button
                                    type="button"
                                    className="-mt-2 self-start text-sm text-emerald-600 underline-offset-4 hover:underline dark:text-emerald-400"
                                    onClick={() => folderInputRef.current?.click()}
                                >
                                    {t("expertLibrary.addSkill.chooseFolder")}
                                </button>

                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    multiple
                                    accept=".md,.markdown,.zip"
                                    className="hidden"
                                    onChange={(event) => {
                                        void handleFiles(Array.from(event.target.files || []));
                                        event.target.value = "";
                                    }}
                                />
                                <input
                                    ref={zipInputRef}
                                    type="file"
                                    multiple
                                    accept=".zip"
                                    className="hidden"
                                    onChange={(event) => {
                                        void handleFiles(Array.from(event.target.files || []));
                                        event.target.value = "";
                                    }}
                                />
                                <input
                                    ref={folderInputRef}
                                    type="file"
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        void handleFiles(Array.from(event.target.files || []));
                                        event.target.value = "";
                                    }}
                                />

                                {parsed ? (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-stone-500 dark:text-stone-400">
                                                {t("expertLibrary.addSkill.parsedSummary", { total: parsed.length, safe: safeCount, risky: riskyCount })}
                                            </span>
                                            <Button
                                                type="primary"
                                                size="small"
                                                loading={installing}
                                                disabled={!parsed.length}
                                                onClick={() => void install(parsed.filter((skill) => !autoInstall || !skill.risky))}
                                            >
                                                {t("expertLibrary.addSkill.installSelected")}
                                            </Button>
                                        </div>
                                        <ul className="flex max-h-52 flex-col gap-1.5 overflow-y-auto thin-scrollbar">
                                            {parsed.map((skill) => (
                                                <li
                                                    key={skill.name}
                                                    className="flex items-start gap-2 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800"
                                                >
                                                    {skill.risky ? (
                                                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                                                    ) : (
                                                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                                                    )}
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{skill.name}</span>
                                                            {skill.risky ? (
                                                                <Tag color="warning" className="m-0 text-[11px]">
                                                                    {t("expertLibrary.addSkill.risky")}
                                                                </Tag>
                                                            ) : null}
                                                        </div>
                                                        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{skill.description}</p>
                                                        {skill.risky && skill.riskReasons.length ? (
                                                            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{skill.riskReasons.join("；")}</p>
                                                        ) : null}
                                                        <p className="mt-0.5 truncate text-[11px] text-stone-400 dark:text-stone-500">{skill.origin}</p>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}

                                {failures.length ? (
                                    <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                                        <div className="flex items-center gap-1.5 font-medium">
                                            <CircleAlert className="size-3.5" />
                                            {t("expertLibrary.addSkill.parseFailures", { count: failures.length })}
                                        </div>
                                        <ul className="mt-1 list-disc space-y-0.5 pl-4">
                                            {failures.map((failure) => (
                                                <li key={`${failure.name}:${failure.code}`}>
                                                    {failure.name}：{t(`expertLibrary.addSkill.errors.${failure.code}`)}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}
                            </div>
                        ),
                    },
                    {
                        key: "create",
                        label: t("expertLibrary.addSkill.tabCreate"),
                        children: (
                            <div className="flex flex-col gap-5 pt-1">
                                <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/40">
                                    <div className="flex items-center gap-2">
                                        <Sparkles className="size-4 text-emerald-500" />
                                        <span className="text-sm font-medium text-stone-800 dark:text-stone-100">{t("expertLibrary.addSkill.aiCreate")}</span>
                                    </div>
                                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 dark:border-stone-700 dark:bg-stone-900">
                                        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                            <Sparkles className="size-3" />
                                            skill-creator
                                        </span>
                                        <span className="min-w-0 flex-1 text-sm leading-6 text-stone-700 dark:text-stone-200">
                                            {t("expertLibrary.addSkill.aiPromptPrefix")}
                                            <span className="text-stone-400 dark:text-stone-500">
                                                {aiPrompt || t("expertLibrary.addSkill.aiPlaceholder")}
                                            </span>
                                            {t("expertLibrary.addSkill.aiPromptSuffix")}
                                        </span>
                                    </div>
                                    <Input
                                        className="mt-2"
                                        value={aiPrompt}
                                        placeholder={t("expertLibrary.addSkill.aiExample")}
                                        onChange={(event) => setAiPrompt(event.target.value)}
                                    />
                                    <div className="mt-2 flex items-center justify-between gap-3">
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{t("expertLibrary.addSkill.aiHint")}</span>
                                        <Button type="primary" icon={<Sparkles className="size-4" />} onClick={handleAiCreate}>
                                            {t("expertLibrary.addSkill.aiButton")}
                                        </Button>
                                    </div>
                                </div>

                                <Form form={form} layout="vertical" requiredMark="optional" className="border-t border-stone-200 pt-4 dark:border-stone-800">
                                    <div className="mb-2 text-sm font-medium text-stone-800 dark:text-stone-100">{t("expertLibrary.addSkill.manualCreate")}</div>
                                    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                                        <Form.Item
                                            name="name"
                                            label={t("expertLibrary.addSkill.fieldName")}
                                            rules={[
                                                { required: true, message: t("expertLibrary.addSkill.fieldNameRequired") },
                                                { pattern: SKILL_NAME_PATTERN, message: t("expertLibrary.addSkill.fieldNamePattern") },
                                            ]}
                                        >
                                            <Input placeholder="my-skill-name" maxLength={64} />
                                        </Form.Item>
                                        <Form.Item name="displayName" label={t("expertLibrary.addSkill.fieldDisplayName")}>
                                            <Input placeholder={t("expertLibrary.addSkill.fieldDisplayNamePlaceholder")} maxLength={64} />
                                        </Form.Item>
                                    </div>
                                    <Form.Item
                                        name="description"
                                        label={t("expertLibrary.addSkill.fieldDescription")}
                                        rules={[
                                            { required: true, message: t("expertLibrary.addSkill.fieldDescriptionRequired") },
                                            {
                                                validator: (_, value: string) =>
                                                    typeof value === "string" && /[<>]/.test(value)
                                                        ? Promise.reject(new Error(t("expertLibrary.addSkill.fieldDescriptionAngle")))
                                                        : Promise.resolve(),
                                            },
                                        ]}
                                    >
                                        <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={1024} />
                                    </Form.Item>
                                    <Form.Item
                                        name="instructions"
                                        label={t("expertLibrary.addSkill.fieldInstructions")}
                                        rules={[{ required: true, message: t("expertLibrary.addSkill.fieldInstructionsRequired") }]}
                                    >
                                        <Input.TextArea className="!leading-6" autoSize={{ minRows: 5, maxRows: 10 }} />
                                    </Form.Item>
                                    <Button type="primary" loading={saving} icon={<Check className="size-4" />} onClick={() => void handleManualCreate()}>
                                        {t("expertLibrary.addSkill.manualButton")}
                                    </Button>
                                </Form>
                            </div>
                        ),
                    },
                    {
                        key: "link",
                        label: t("expertLibrary.addSkill.tabLink"),
                        children: (
                            <div className="flex flex-col gap-4 pt-1">
                                <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("expertLibrary.addSkill.linkHint")}</div>
                                <div className="flex flex-wrap gap-2">
                                    {[
                                        { icon: <GitBranch className="size-3.5" />, text: "https://github.com/owner/repo" },
                                        { icon: <Globe className="size-3.5" />, text: "https://gitee.com/owner/repo" },
                                        { icon: <Link2 className="size-3.5" />, text: "…/blob/main/skill/SKILL.md" },
                                    ].map((example) => (
                                        <button
                                            key={example.text}
                                            type="button"
                                            className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-2.5 py-1 text-[11px] text-stone-500 transition hover:border-stone-300 hover:text-stone-700 dark:border-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
                                            onClick={() => setLink(example.text)}
                                        >
                                            {example.icon}
                                            {example.text}
                                        </button>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <Input
                                        value={link}
                                        onChange={(event) => setLink(event.target.value)}
                                        onPressEnter={() => void handleRemote()}
                                        prefix={<Link2 className="size-4 text-stone-400" />}
                                        placeholder={t("expertLibrary.addSkill.linkPlaceholder")}
                                    />
                                    <Button type="primary" loading={linking} onClick={() => void handleRemote()}>
                                        {linking ? <LoaderCircle className="size-4 animate-spin" /> : t("expertLibrary.addSkill.linkResolve")}
                                    </Button>
                                </div>
                                {remoteError ? (
                                    <Alert type="error" showIcon message={t(`expertLibrary.addSkill.remoteErrors.${remoteError}`)} />
                                ) : null}
                                {parsed && parsed.length ? (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-stone-500 dark:text-stone-400">
                                                {t("expertLibrary.addSkill.parsedSummary", { total: parsed.length, safe: safeCount, risky: riskyCount })}
                                            </span>
                                            <Button type="primary" size="small" loading={installing} onClick={() => void install(parsed)}>
                                                {t("expertLibrary.addSkill.installSelected")}
                                            </Button>
                                        </div>
                                        <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto thin-scrollbar">
                                            {parsed.map((skill) => (
                                                <li key={skill.name} className="flex items-start gap-2 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                                                    <FileArchive className="mt-0.5 size-4 shrink-0 text-stone-400" />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{skill.name}</span>
                                                            {skill.risky ? (
                                                                <Tag color="warning" className="m-0 text-[11px]">
                                                                    {t("expertLibrary.addSkill.risky")}
                                                                </Tag>
                                                            ) : null}
                                                        </div>
                                                        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{skill.description}</p>
                                                        <p className="mt-0.5 truncate text-[11px] text-stone-400 dark:text-stone-500">{skill.origin}</p>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}
                                <div className="flex items-center gap-1.5 text-xs text-stone-400 dark:text-stone-500">
                                    <FolderUp className="size-3.5" />
                                    {t("expertLibrary.addSkill.linkInstallHint")}
                                </div>
                            </div>
                        ),
                    },
                ]}
            />

            <Modal
                title={t("expertLibrary.addSkill.conflictTitle", { count: conflictSkills?.length || 0 })}
                open={!!conflictSkills}
                onCancel={() => (installing ? undefined : setConflictSkills(null))}
                footer={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button disabled={installing} onClick={() => setConflictSkills(null)}>
                            {t("expertLibrary.addSkill.conflictKeep")}
                        </Button>
                        <Button disabled={installing} onClick={() => void resolveConflicts("rename")}>
                            {t("expertLibrary.addSkill.conflictRename")}
                        </Button>
                        <Button type="primary" danger disabled={installing} onClick={() => void resolveConflicts("overwrite")}>
                            {t("expertLibrary.addSkill.conflictOverwrite")}
                        </Button>
                    </div>
                }
                width={520}
                centered
            >
                <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
                    {t("expertLibrary.addSkill.conflictDesc", {
                        names: (conflictSkills || []).map((skill) => skill.name).join("、"),
                        example: `${(conflictSkills || [])[0]?.name || "skill"}-2`,
                    })}
                </p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-stone-500 dark:text-stone-400">
                    {(conflictSkills || []).map((skill) => (
                        <li key={skill.name}>
                            <span className="font-medium text-stone-700 dark:text-stone-200">{skill.name}</span> — {skill.description}
                        </li>
                    ))}
                </ul>
            </Modal>
        </Modal>
    );
}
