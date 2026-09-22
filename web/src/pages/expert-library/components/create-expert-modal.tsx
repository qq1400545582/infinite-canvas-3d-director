import { useEffect, useRef, useState } from "react";
import { App, Button, Form, Input, Modal, Tag, Tabs } from "antd";
import { Check, CircleAlert, Sparkles, UserPlus, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { expertIdFromName, normalizeExpert } from "../state/user-library";
import type { LibraryItem } from "../data/types";
import { useAgentStore } from "@/stores/use-agent-store";
import { cn } from "@/lib/utils";

type ExpertForm = {
    name: string;
    category: string;
    description: string;
    features?: string;
    tags?: string;
    callPrompt?: string;
};

/** AI 解析出的专家画像。 */
export type ExpertProfile = {
    name: string;
    category: string;
    description: string;
    features: string[];
    tags: string[];
    callPrompt: string;
};

const CATEGORY_PRESETS = ["写作创作", "设计创意", "编程开发", "数据智能", "营销增长", "法务合规", "财务金融", "教育培训", "效率工具"];

/**
 * 「创建专属专家」弹窗。
 *
 * - AI 创建：把结构化的「专家画像」需求发给画布智能体，并自动监听面板里的 AI 回复；
 *   用户点「解析并创建」即可把 AI 输出直接变成「我的专家」。
 * - 手动填写：直接填写名称 / 分类 / 简介 / 能力点 / 调用提示，保存到「我的专家」。
 *
 * 「我的专家」保存在本地（localStorage），可立即调用、并注册为画布节点。
 */
export function CreateExpertModal({
    open,
    onClose,
    onCreated,
    onRequireAgent,
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (item: LibraryItem) => void;
    onRequireAgent: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [tab, setTab] = useState<"ai" | "manual">("ai");
    const [requirement, setRequirement] = useState("");
    const [watching, setWatching] = useState(false);
    const [aiText, setAiText] = useState("");
    const [parseError, setParseError] = useState(false);
    const [form] = Form.useForm<ExpertForm>();
    const seenRef = useRef<{ busy: boolean; captured: boolean }>({ busy: false, captured: false });

    useEffect(() => {
        if (open) return;
        setWatching(false);
        setAiText("");
        setParseError(false);
        seenRef.current = { busy: false, captured: false };
    }, [open]);

    // 监听画布智能体面板中的最新 AI 回复，自动回填「AI 输出」文本框。
    useEffect(() => {
        if (!watching) return;
        const unsubscribe = useAgentStore.subscribe((state) => {
            const latest = [...state.messages].reverse().find((item) => item.role === "assistant" && item.text.trim());
            if (latest) {
                setAiText(latest.text);
                if (!seenRef.current.captured) {
                    seenRef.current.captured = true;
                    message.success(t("expertLibrary.createExpert.aiCaptured"));
                }
            }
            if (state.waiting || state.sending) seenRef.current.busy = true;
            else if (seenRef.current.busy) {
                setWatching(false);
            }
        });
        return unsubscribe;
    }, [watching, message, t]);

    const askAi = () => {
        const agent = useAgentStore.getState();
        seenRef.current = { busy: false, captured: false };
        agent.openPanel();
        agent.setAgentState({
            prompt: buildExpertPrompt(requirement.trim(), t("expertLibrary.createExpert.aiFallbackRequirement")),
            activeTab: "chat",
        });
        setWatching(true);
        if (!agent.connected) onRequireAgent();
        else message.info(t("expertLibrary.createExpert.aiSent"));
    };

    const createFromProfile = (profile: ExpertProfile) => {
        const item = normalizeExpert({
            id: expertIdFromName(profile.name),
            kind: "expert",
            name: profile.name,
            category: profile.category || t("expertLibrary.myExperts.category"),
            icon: "userPlus",
            description: profile.description,
            tags: profile.tags.length ? profile.tags : [t("expertLibrary.myExperts.category")],
            features: profile.features,
            callPrompt: profile.callPrompt || t("expertLibrary.createExpert.defaultCallPrompt", { name: profile.name }),
            meta: { 来源: t("expertLibrary.myExperts.category"), 创建方式: t("expertLibrary.createExpert.aiCreate") },
            source: "user",
            origin: t("expertLibrary.createExpert.aiCreate"),
            installedAt: Date.now(),
        });
        onCreated(item);
        message.success(t("expertLibrary.createExpert.created", { name: profile.name }));
        onClose();
    };

    const handleParseCreate = () => {
        const profile = parseExpertProfile(aiText);
        if (!profile) {
            setParseError(true);
            message.warning(t("expertLibrary.createExpert.parseFailed"));
            return;
        }
        setParseError(false);
        createFromProfile(profile);
    };

    const handleManualCreate = async () => {
        let values: ExpertForm;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const name = values.name.trim();
        createFromProfile({
            name,
            category: values.category?.trim() || t("expertLibrary.myExperts.category"),
            description: values.description.trim(),
            features: splitLines(values.features),
            tags: splitList(values.tags),
            callPrompt: values.callPrompt?.trim() || t("expertLibrary.createExpert.defaultCallPrompt", { name }),
        });
    };

    return (
        <Modal title={t("expertLibrary.createExpert.title")} open={open} onCancel={onClose} footer={null} width={600} centered destroyOnHidden>
            <Tabs
                activeKey={tab}
                onChange={(key) => setTab(key as "ai" | "manual")}
                items={[
                    {
                        key: "ai",
                        label: t("expertLibrary.createExpert.tabAi"),
                        children: (
                            <div className="flex flex-col gap-3 pt-1">
                                <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("expertLibrary.createExpert.aiDesc")}</div>
                                <Input.TextArea
                                    value={requirement}
                                    onChange={(event) => setRequirement(event.target.value)}
                                    autoSize={{ minRows: 2, maxRows: 4 }}
                                    placeholder={t("expertLibrary.createExpert.aiPlaceholder")}
                                />
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-xs text-stone-400 dark:text-stone-500">{t("expertLibrary.createExpert.aiHint")}</span>
                                    <Button type="primary" icon={<Wand2 className="size-4" />} onClick={askAi}>
                                        {t("expertLibrary.createExpert.aiCreate")}
                                    </Button>
                                </div>

                                <div className="mt-1 border-t border-stone-200 pt-3 dark:border-stone-800">
                                    <div className="mb-2 flex items-center justify-between">
                                        <span className="text-sm font-medium text-stone-800 dark:text-stone-100">{t("expertLibrary.createExpert.aiOutput")}</span>
                                        {watching ? (
                                            <Tag color="processing" className="m-0 text-[11px]">
                                                {t("expertLibrary.createExpert.aiWatching")}
                                            </Tag>
                                        ) : null}
                                    </div>
                                    <Input.TextArea
                                        value={aiText}
                                        onChange={(event) => setAiText(event.target.value)}
                                        autoSize={{ minRows: 5, maxRows: 10 }}
                                        placeholder={t("expertLibrary.createExpert.aiOutputPlaceholder")}
                                    />
                                    {parseError ? (
                                        <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                                            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                                            {t("expertLibrary.createExpert.parseFailedHint")}
                                        </div>
                                    ) : null}
                                    <div className="mt-3 flex items-center gap-2">
                                        <Button type="primary" icon={<Check className="size-4" />} disabled={!aiText.trim()} onClick={handleParseCreate}>
                                            {t("expertLibrary.createExpert.parseCreate")}
                                        </Button>
                                        <Button
                                            onClick={() => {
                                                const profile = parseExpertProfile(aiText);
                                                if (!profile) {
                                                    setParseError(true);
                                                    message.warning(t("expertLibrary.createExpert.parseFailed"));
                                                    return;
                                                }
                                                setParseError(false);
                                                setTab("manual");
                                                form.setFieldsValue({
                                                    name: profile.name,
                                                    category: profile.category,
                                                    description: profile.description,
                                                    features: profile.features.join("\n"),
                                                    tags: profile.tags.join("、"),
                                                    callPrompt: profile.callPrompt,
                                                });
                                            }}
                                            disabled={!aiText.trim()}
                                        >
                                            {t("expertLibrary.createExpert.parseToForm")}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "manual",
                        label: t("expertLibrary.createExpert.tabManual"),
                        children: (
                            <Form form={form} layout="vertical" requiredMark="optional" initialValues={{ category: CATEGORY_PRESETS[0] }} className="pt-1">
                                <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                                    <Form.Item name="name" label={t("expertLibrary.createExpert.fieldName")} rules={[{ required: true, message: t("expertLibrary.createExpert.fieldNameRequired") }]}>
                                        <Input placeholder={t("expertLibrary.createExpert.fieldNamePlaceholder")} maxLength={40} />
                                    </Form.Item>
                                    <Form.Item name="category" label={t("expertLibrary.createExpert.fieldCategory")}>
                                        <Input placeholder={t("expertLibrary.createExpert.fieldCategoryPlaceholder")} maxLength={20} />
                                    </Form.Item>
                                </div>
                                <div className="mb-4 flex flex-wrap gap-1.5">
                                    {CATEGORY_PRESETS.map((preset) => (
                                        <button
                                            key={preset}
                                            type="button"
                                            className={cn(
                                                "rounded-full border px-2.5 py-1 text-[11px] transition",
                                                "border-stone-200 text-stone-500 hover:border-stone-300 hover:text-stone-700",
                                                "dark:border-stone-700 dark:text-stone-400 dark:hover:text-stone-200",
                                            )}
                                            onClick={() => form.setFieldValue("category", preset)}
                                        >
                                            {preset}
                                        </button>
                                    ))}
                                </div>
                                <Form.Item name="description" label={t("expertLibrary.createExpert.fieldDescription")} rules={[{ required: true, message: t("expertLibrary.createExpert.fieldDescriptionRequired") }]}>
                                    <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} maxLength={400} showCount />
                                </Form.Item>
                                <Form.Item name="features" label={t("expertLibrary.createExpert.fieldFeatures")} extra={t("expertLibrary.createExpert.fieldFeaturesExtra")}>
                                    <Input.TextArea autoSize={{ minRows: 4, maxRows: 8 }} />
                                </Form.Item>
                                <Form.Item name="tags" label={t("expertLibrary.createExpert.fieldTags")} extra={t("expertLibrary.createExpert.fieldTagsExtra")}>
                                    <Input placeholder={t("expertLibrary.createExpert.fieldTagsPlaceholder")} />
                                </Form.Item>
                                <Form.Item name="callPrompt" label={t("expertLibrary.createExpert.fieldCallPrompt")} extra={t("expertLibrary.createExpert.fieldCallPromptExtra")}>
                                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
                                </Form.Item>
                                <Button type="primary" icon={<UserPlus className="size-4" />} onClick={() => void handleManualCreate()}>
                                    {t("expertLibrary.createExpert.manualCreate")}
                                </Button>
                            </Form>
                        ),
                    },
                ]}
            />
        </Modal>
    );
}

function buildExpertPrompt(requirement: string, fallback: string) {
    return [
        "请帮我创建一个「专属专家」的角色定义。",
        `专家需求：${requirement || fallback}`,
        "",
        "请只输出一个 JSON 对象（不要输出任何解释文字，不要使用 Markdown 代码块），字段与含义如下：",
        "{",
        '  "name": "专家名称，中文，10 个字以内",',
        '  "category": "分类，从以下中选择：写作创作 / 设计创意 / 编程开发 / 数据智能 / 营销增长 / 法务合规 / 财务金融 / 教育培训 / 效率工具",',
        '  "description": "一句话简介，60-120 字，说明该专家擅长什么、适合解决什么问题",',
        '  "features": ["4 条具体能力点，每条 8-20 字"],',
        '  "tags": ["3 个检索标签"],',
        '  "callPrompt": "以该专家身份开始工作时的指令前缀，例如：请以「XX 专家」的身份，结合……帮我完成下面的任务："',
        "}",
    ].join("\n");
}

/** 宽容解析 AI 输出：优先 JSON，其次键值行。 */
export function parseExpertProfile(text: string): ExpertProfile | null {
    const raw = (text || "").trim();
    if (!raw) return null;
    const json = extractJsonObject(raw);
    if (json) {
        const name = stringValue(json.name);
        const description = stringValue(json.description);
        if (name && description) {
            return {
                name,
                category: stringValue(json.category),
                description,
                features: stringList(json.features),
                tags: stringList(json.tags),
                callPrompt: stringValue(json.callPrompt || json.call_prompt),
            };
        }
    }
    const lines = raw.split(/\r?\n/);
    const pick = (keys: string[]) => {
        for (const line of lines) {
            const match = /^\s*[-*]?\s*([^:：]{2,12})\s*[:：]\s*(.+)$/.exec(line);
            if (!match) continue;
            if (keys.some((key) => match[1].trim().toLowerCase() === key.toLowerCase())) return match[2].trim();
        }
        return "";
    };
    const name = pick(["name", "名称", "专家名称"]);
    const description = pick(["description", "简介", "描述", "专家简介"]);
    if (!name || !description) return null;
    return {
        name,
        category: pick(["category", "分类"]),
        description,
        features: [],
        tags: [],
        callPrompt: pick(["callPrompt", "调用提示", "指令"]),
    };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        const value = JSON.parse(text.slice(start, end + 1)) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown) {
    if (Array.isArray(value)) return value.map((entry) => stringValue(entry)).filter(Boolean);
    const text = stringValue(value);
    return text ? splitList(text) : [];
}

function splitLines(value?: string) {
    return (value || "")
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*·]\s*/, "").trim())
        .filter(Boolean);
}

function splitList(value?: string) {
    return (value || "")
        .split(/[,，、;；\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
