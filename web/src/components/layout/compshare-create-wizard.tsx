import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Input, InputNumber, Modal, Select, Space, Tabs, Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ensureAgentTarget } from "@/pages/expert-library/agent-bridge";
import type { CompShareImage, CompShareInstanceType, CompShareOverview } from "./compshare-client";
import { ImagePickerModal } from "@/components/layout/compshare-image-picker";

/**
 * 创建 GPU 实例向导 —— 字段与优云智算控制台的创建页保持一致：
 *
 *   实例配置：GPU 卡型 / GPU 数量 / CPU 核数 / 内存 / 镜像 / 系统盘 / 计费模式 / 实例名称
 *   地域：    Region + Zone（从 DescribeCompShareSupportZone 取）
 *   存储配置：系统盘容量（平台 100GB SSD 免费）+ 云存储Pro 挂载开关
 *   更多配置：HTTP 端口 / TCP 端口 / SSH 公钥 / 备注
 *
 * 两条平台硬约束在这里做前置校验（不把错误留给上游、也不浪费一次计费调用）：
 *   · **CPU/内存的合法组合必须来自 `DescribeAvailableCompShareInstanceTypes`**，
 *     不能任意搭配 —— 所以选卡型后 CPU/内存会收敛到该卡型的合法值。
 *   · 内存必须是 1024 的整数倍（MB）。
 */
export function CreateInstanceWizard({ open, overview, onClose, onCreated }: { open: boolean; overview: CompShareOverview | null; onClose: () => void; onCreated: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();

    const [zone, setZone] = useState("");
    const [gpuType, setGpuType] = useState("4090");
    const [gpuCount, setGpuCount] = useState(1);
    const [cpu, setCpu] = useState<number | undefined>();
    const [memory, setMemory] = useState<number | undefined>();
    const [imageId, setImageId] = useState("");
    const [pickedImage, setPickedImage] = useState<CompShareImage | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    // 服务端检索到的镜像（本地已加载的镜像里搜不到时的补充）
    const [remoteImages, setRemoteImages] = useState<CompShareImage[]>([]);
    const [searching, setSearching] = useState(false);
    const [diskSize, setDiskSize] = useState(50);
    const [chargeType, setChargeType] = useState("Postpay");
    const [name, setName] = useState("");
    const [remark, setRemark] = useState("");
    const [httpPorts, setHttpPorts] = useState<string>("");
    const [tcpPorts, setTcpPorts] = useState<string>("");
    const [sshPubKey, setSshPubKey] = useState("");
    const [enableCfs, setEnableCfs] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    /** 该卡型下的合法规格组合（平台的 CPU/内存不是任意搭配）。 */
    const specs = useMemo<CompShareInstanceType[]>(() => (overview?.instanceTypes || []).filter((item) => item.gpuType === gpuType), [overview, gpuType]);
    const gpuTypes = useMemo(() => [...new Set((overview?.instanceTypes || []).map((item) => item.gpuType).filter(Boolean))], [overview]);

    // 选中卡型后，把 CPU/内存收敛到平台给出的合法组合
    useEffect(() => {
        const first = specs[0];
        if (!first) return;
        setGpuCount((prev) => (prev >= 1 && prev <= (first.gpuCount || 1) ? prev : 1));
        setCpu(first.cpu || undefined);
        setMemory(first.memoryGb ? first.memoryGb * 1024 : undefined);
    }, [specs]);

    // 可用区：默认选第一个
    useEffect(() => {
        if (!zone && overview?.zones?.length) setZone(overview.zones[0]);
    }, [overview, zone]);

    // 镜像分组：仅用于「默认选第一个」（选择 UI 已由镜像库弹窗接管）
    const imageGroups = useMemo(() => {
        const groups: { key: string; label: string; options: { value: string; label: string }[] }[] = [
            { key: "community", label: t("compshare.imageGroup.community"), options: [] },
            { key: "platform", label: t("compshare.imageGroup.platform"), options: [] },
            { key: "custom", label: t("compshare.imageGroup.custom"), options: [] },
        ];
        for (const image of overview?.images || []) {
            const group = groups.find((entry) => entry.key === image.source) || groups[1];
            const suffix = image.author ? ` · ${image.author}` : "";
            group.options.push({ value: image.id, label: `${image.name}${suffix}` });
        }
        return groups.map((group) => ({ ...group, label: `${group.label} (${group.options.length})` })).filter((group) => group.options.length);
    }, [overview, t]);

    useEffect(() => {
        // 默认选第一个可用镜像（社区优先，其次平台）；默认选中即可直接创建，省一次点击
        if (!imageId && imageGroups.length) {
            const first = imageGroups[0].options[0].value;
            setImageId(first);
            setPickedImage(overview?.images?.find((item) => item.id === first) || null);
        }
    }, [imageGroups, imageId, overview]);

    /**
     * 本地已加载的镜像里搜不到时，到平台侧按名称/作者再精确查一次。
     *
     * 为什么要服务端检索：社区镜像上千条，而 Agent 翻页有上限（避免一次拉爆），
     * 未翻到的页只能靠平台自己的 `FuzzySearch` 找到 —— 用户按作者名搜尤其依赖它。
     */
    const searchRemoteImages = async (keyword: string) => {
        setSearching(true);
        try {
            const target = await ensureAgentTarget();
            if (!target?.token) {
                message.error(t("compshare.agentMissing"));
                return;
            }
            const response = await fetch(`${target.endpoint}/agent/compshare/images/search?token=${encodeURIComponent(target.token)}`, {
                method: "POST",
                headers: { accept: "application/json", "content-type": "application/json" },
                body: JSON.stringify({ keyword }),
                signal: AbortSignal.timeout(60_000),
            });
            const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: { images?: CompShareImage[]; error?: string } } | null;
            if (!payload?.ok) {
                message.error(payload?.data?.error || t("compshare.failed"));
                return;
            }
            const found = payload.data?.images || [];
            setRemoteImages(found);
            message.success(found.length ? t("compshare.imagePicker.remoteFound", { count: found.length }) : t("compshare.imagePicker.remoteEmpty", { keyword }));
        } catch {
            // fetch 抛 TypeError = 连不上本机 Agent（未运行或版本过旧），换成人能行动的提示
            message.error(t("compshare.agentUnreachable"));
        } finally {
            setSearching(false);
        }
    };

    /** 镜像库展示用列表 = 已加载的 + 服务端检索到的（按 id 去重，检索结果优先）。 */
    const pickerImages = useMemo(() => {
        const byId = new Map<string, CompShareImage>();
        for (const image of overview?.images || []) byId.set(image.id, image);
        for (const image of remoteImages) byId.set(image.id, image);
        return [...byId.values()];
    }, [overview, remoteImages]);

    /** 把 "8888,8889" 或 "8888\n8889" 解析成整数数组；忽略空项与非数字。 */
    const parsePorts = (text: string) =>
        text
            .split(/[\s,;]+/)
            .map((item) => Number(item))
            .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);

    const buildParams = () => ({
        Region: zone.split("-").slice(0, 2).join("-") || "cn-wlcb",
        Zone: zone,
        MachineType: "G",
        GpuType: gpuType,
        GPU: gpuCount,
        CPU: cpu ?? 0,
        Memory: memory ?? 0,
        CompShareImageId: imageId,
        ChargeType: chargeType,
        Name: name.trim() || undefined,
        Remark: remark.trim() || undefined,
        Disks: [{ IsBoot: true, Type: "CLOUD_SSD", Size: diskSize }],
        SecurityGroupId: undefined,
        EnableCfs: enableCfs,
        // 端口与 SSH 公钥：平台以 UserData/SecurityGroup 形式承载，这里按文档字段名传
        ...(parsePorts(httpPorts).length ? { HTTPPorts: parsePorts(httpPorts) } : {}),
        ...(parsePorts(tcpPorts).length ? { TCPPorts: parsePorts(tcpPorts) } : {}),
        ...(sshPubKey.trim() ? { SSHPubKey: sshPubKey.trim() } : {}),
    });

    const call = async (endpoint: string, body: Record<string, unknown>) => {
        const agent = await ensureAgentTarget();
        if (!agent?.token) throw new Error(t("compshare.agentMissing"));
        const response = await fetch(`${agent.endpoint}${endpoint}?token=${encodeURIComponent(agent.token)}`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });
        const payload = (await response.json()) as { ok?: boolean; data?: unknown; error?: string };
        if (!payload.ok) throw new Error(payload.error || t("compshare.failed"));
        return payload.data;
    };

    const checkCapacity = async () => {
        setSubmitting(true);
        try {
            await call("/agent/compshare/instances/capacity", { params: buildParams() });
            message.success(t("compshare.capacityOk"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setSubmitting(false);
        }
    };

    const create = async () => {
        if (!imageId) {
            message.warning(t("compshare.validation.pickImage"));
            return;
        }
        if (!cpu || !memory) {
            message.warning(t("compshare.validation.pickSpec"));
            return;
        }
        setSubmitting(true);
        try {
            await call("/agent/compshare/instances/create", { confirm: true, params: buildParams() });
            message.success(t("compshare.created"));
            onCreated();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <>
        <ImagePickerModal
            open={pickerOpen}
            images={pickerImages}
            communityTotal={overview?.communityTotal}
            value={imageId}
            searching={searching}
            onSearchRemote={(keyword) => void searchRemoteImages(keyword)}
            onClose={() => setPickerOpen(false)}
            onPick={(image) => {
                // 社区镜像的 CompShareImageId 可直接用于创建实例 —— 选中即部署
                setPickedImage(image);
                setImageId(image.id);
                setPickerOpen(false);
            }}
        />
        <Modal open={open} onCancel={onClose} title={t("compshare.create")} footer={null} width={780} destroyOnHidden>
            <Tabs
                size="small"
                items={[
                    {
                        key: "instance",
                        label: t("compshare.section.instance"),
                        children: (
                            <div className="flex flex-col gap-3 pt-2">
                                <Section title={t("compshare.section.instance")}>
                                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                                        <Field label={t("compshare.field.gpuType")}>
                                            <Select value={gpuType} onChange={setGpuType} options={gpuTypes.map((value) => ({ value, label: value }))} placeholder={t("compshare.field.gpuTypePlaceholder")} />
                                        </Field>
                                        <Field label={t("compshare.field.gpuCount")}>
                                            <InputNumber className="w-full" min={1} max={specs[0]?.gpuCount || 8} value={gpuCount} onChange={(value) => setGpuCount(value || 1)} />
                                        </Field>
                                        <Field label={t("compshare.field.cpu")}>
                                            <Select
                                                value={cpu}
                                                onChange={setCpu}
                                                // 平台的 CPU/内存组合是限定集合，这里只给合法值
                                                options={[...new Set(specs.map((item) => item.cpu).filter(Boolean))].map((value) => ({ value, label: `${value} 核` }))}
                                                placeholder={t("compshare.field.cpuPlaceholder")}
                                            />
                                        </Field>
                                        <Field label={t("compshare.field.memory")}>
                                            <Select
                                                value={memory}
                                                onChange={setMemory}
                                                options={[...new Set(specs.map((item) => item.memoryGb).filter(Boolean))].map((value) => ({ value: value * 1024, label: `${value} GB` }))}
                                                placeholder={t("compshare.field.memoryPlaceholder")}
                                            />
                                        </Field>
                                        <Field label={t("compshare.field.charge")}>
                                            <Select
                                                value={chargeType}
                                                onChange={setChargeType}
                                                options={[
                                                    { value: "Postpay", label: t("compshare.charge.postpay") },
                                                    { value: "Day", label: t("compshare.charge.day") },
                                                    { value: "Month", label: t("compshare.charge.month") },
                                                    { value: "Spot", label: t("compshare.charge.spot") },
                                                ]}
                                            />
                                        </Field>
                                        <Field label={t("compshare.field.name")}>
                                            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("compshare.field.namePlaceholder")} />
                                        </Field>
                                    </div>
                                    <Field label={t("compshare.field.image")}>
                                        {/* 搜索在镜像库弹窗内做（那里才有封面图与分类栏），
                                            这里只显示已选结果 + 打开镜像库 */}
                                        <div className="flex gap-2">
                                            <Input value={pickedImage ? pickedImage.name : ""} readOnly placeholder={t("compshare.field.imagePlaceholder")} />
                                            <Button onClick={() => setPickerOpen(true)}>{t("compshare.imagePicker.browse")}</Button>
                                            {pickedImage ? (
                                                <Button onClick={() => { setPickedImage(null); setImageId(""); }}>{t("compshare.imagePicker.clear")}</Button>
                                            ) : null}
                                        </div>
                                        <p className="mt-1 text-[11px] text-stone-400">{t("compshare.field.imageHint", { total: overview?.communityTotal || overview?.images?.length || 0 })}</p>
                                        {pickedImage ? (
                                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500">
                                                {pickedImage.cover ? <img src={pickedImage.cover} alt="" className="size-6 rounded object-cover" /> : null}
                                                {pickedImage.author ? <span>{t("compshare.imagePicker.author")}：{pickedImage.author}</span> : null}
                                                {/* 选中社区镜像后明确告知可直接部署：它的 id 就是创建参数 */}
                                                <span className="text-stone-400">{pickedImage.id}</span>
                                                {pickedImage.free ? (
                                                    <Tag color="green" className="m-0 text-[10px]">
                                                        {t("compshare.imagePicker.free")}
                                                    </Tag>
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </Field>
                                </Section>
                            </div>
                        ),
                    },
                    {
                        key: "region",
                        label: t("compshare.section.region"),
                        children: (
                            <div className="flex flex-col gap-3 pt-2">
                                <Section title={t("compshare.section.region")}>
                                    <div className="grid grid-cols-2 gap-3">
                                        <Field label={t("compshare.field.region")}>
                                            <Input value={zone ? zone.split("-").slice(0, 2).join("-") : ""} readOnly />
                                        </Field>
                                        <Field label={t("compshare.field.zone")}>
                                            <Select value={zone} onChange={setZone} options={(overview?.zones || []).map((value) => ({ value, label: value }))} placeholder={t("compshare.field.zonePlaceholder")} />
                                        </Field>
                                    </div>
                                </Section>
                                <Section title={t("compshare.section.storage")}>
                                    <div className="grid grid-cols-2 gap-3">
                                        <Field label={t("compshare.field.disk")}>
                                            <InputNumber className="w-full" min={20} max={100} value={diskSize} onChange={(value) => setDiskSize(value || 50)} addonAfter="GB" />
                                            <p className="mt-1 text-[11px] text-stone-400">{t("compshare.field.diskHint")}</p>
                                        </Field>
                                        <Field label={t("compshare.field.cfs")}>
                                            <Select
                                                value={enableCfs ? "on" : "off"}
                                                onChange={(value) => setEnableCfs(value === "on")}
                                                options={[
                                                    { value: "off", label: t("compshare.cfs.off") },
                                                    { value: "on", label: t("compshare.cfs.on") },
                                                ]}
                                            />
                                            <p className="mt-1 text-[11px] text-stone-400">{t("compshare.field.cfsHint")}</p>
                                        </Field>
                                    </div>
                                </Section>
                            </div>
                        ),
                    },
                    {
                        key: "more",
                        label: t("compshare.section.more"),
                        children: (
                            <div className="flex flex-col gap-3 pt-2">
                                <Section title={t("compshare.section.more")}>
                                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                        <Field label={t("compshare.field.httpPorts")}>
                                            <Input value={httpPorts} onChange={(event) => setHttpPorts(event.target.value)} placeholder="8888, 8889" />
                                            <p className="mt-1 text-[11px] text-stone-400">{t("compshare.field.portsHint")}</p>
                                        </Field>
                                        <Field label={t("compshare.field.tcpPorts")}>
                                            <Input value={tcpPorts} onChange={(event) => setTcpPorts(event.target.value)} placeholder="22, 6006" />
                                        </Field>
                                        <Field label={t("compshare.field.sshPubKey")}>
                                            <Input.TextArea value={sshPubKey} onChange={(event) => setSshPubKey(event.target.value)} rows={3} placeholder="ssh-rsa AAAA…" />
                                        </Field>
                                        <Field label={t("compshare.field.remark")}>
                                            <Input.TextArea value={remark} onChange={(event) => setRemark(event.target.value)} rows={3} placeholder={t("compshare.field.remarkPlaceholder")} />
                                        </Field>
                                    </div>
                                </Section>
                            </div>
                        ),
                    },
                ]}
            />

            <div className="mt-3 flex flex-col gap-3">
                <Alert type="warning" showIcon message={t("compshare.billingWarning")} />
                <div className="flex items-center justify-end gap-2">
                    <Button onClick={() => void checkCapacity()} loading={submitting}>
                        {t("compshare.checkCapacity")}
                    </Button>
                    <Button type="primary" danger loading={submitting} disabled={!imageId} onClick={() => void create()}>
                        {t("compshare.confirmCreate")}
                    </Button>
                </div>
            </div>
        </Modal>
        </>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="mb-2 text-xs font-semibold text-stone-700 dark:text-stone-200">{title}</div>
            {children}
        </section>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[11px] text-stone-500 dark:text-stone-400">{label}</span>
            {children}
        </label>
    );
}
