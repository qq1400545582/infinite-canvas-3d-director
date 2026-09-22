import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";

import { PANELS_NODE_TYPE, PANELS_READY_EVENT } from "./ids";
import { REF_ACTION_CINEMATOGRAPHY, REF_CINEMATIC_LANGUAGE, REF_DELIVERABLE_SCHEMA, REF_VISUAL_PRODUCTION, SKILL_MD } from "./prompts";
import { DEFAULT_GRID, GRID_PRESETS, buildGridPrefix, buildOutputContract, gridLabel, makeGrid, normalizePanels, type GridSpec, type PanelPrompt } from "./spec";
import { MarkdownTables, accentStyles, asText, bodyStyle, errorMessage, extractJson, titleBarStyle, statusTextStyle } from "./shared";

// 分镜工作台（clipshot）
// -----------------------------------------------------------------------------
// 把开源 Skill「cinematic-storyboard-design」(TanShilongMario/clipshot, MIT) 以画布节点的
// 形态落地：节点的系统提示词 = 上游 SKILL.md 与 references 的逐字内容（见 src/prompts.ts，
// 由 tools/gen-prompts.mjs 从上游仓库生成），执行逻辑与源码保持一致的分镜阶段状态机：
//   READ → CONFIRM → CLASSIFY REFERENCES → DESIGN → GENERATE → VISUAL QA → TIMELINE → DELIVER
// 与源码唯一的差别是「运行环境适配」：上游由 Agent 直接调用图像能力出图，这里由节点分两步完成
//   —— 先请文本模型按规范产出分镜总图提示词、逐格提示词与时间线表，再由宿主注入的
//      ctx.ai.generateImage 出图（总图在本节点，逐格由下游「分镜出图」节点）。
// 因此额外追加了一段「输出契约」（见 spec.ts 的 buildOutputContract），要求模型以 JSON 交付。
//
// 分镜格数可在界面上自定义（默认 3×3 九宫格 = 9 格）。格数以外的一切创作规则都取自原文，
// 只有「网格规格」这一处随格数改写（见 spec.ts 顶部说明），3×3 时与 v1.0.0 逐字节一致。
//
// 模型与密钥由宿主注入（ctx.ai），插件不自带、不读取 API Key。

const RATIOS = ["16:9", "3:4", "9:16"] as const;
const GRID_SIDES = [1, 2, 3, 4];

function buildSystemPrompt() {
    return [
        "以下是你必须完整遵守的 Skill 规范（cinematic-storyboard-design）。全部内容为原文，逐字未改。",
        "",
        SKILL_MD,
        "",
        "-----",
        "",
        REF_CINEMATIC_LANGUAGE,
        "",
        "-----",
        "",
        REF_ACTION_CINEMATOGRAPHY,
        "",
        "-----",
        "",
        REF_VISUAL_PRODUCTION,
        "",
        "-----",
        "",
        REF_DELIVERABLE_SCHEMA,
    ].join("\n");
}

export type WorkbenchInputs = {
    script: string;
    ratio: string;
    scope: string;
    usage: string;
    tone: string;
    works: string;
    taboos: string;
    /** 分镜格数：列 / 行（默认 3 × 3 = 九宫格） */
    cols: number;
    rows: number;
};

export type WorkbenchResult = {
    understanding: string;
    split: string;
    imagePrompt: string;
    timeline: string;
    notes: string;
    keyframeQuestion: string;
    grid: string;
    /** 逐格图像提示词（按分镜序列），供下游「分镜出图」节点消费 */
    panels: PanelPrompt[];
    gridSpec: GridSpec;
    /** 本结果的版本号（生成时间戳），下游据此判断是否需要重新出图 */
    version: number;
};

const EMPTY_INPUTS: WorkbenchInputs = { script: "", ratio: "16:9", scope: "", usage: "", tone: "", works: "", taboos: "", cols: DEFAULT_GRID.cols, rows: DEFAULT_GRID.rows };
const EMPTY_RESULT: WorkbenchResult = { understanding: "", split: "", imagePrompt: "", timeline: "", notes: "", keyframeQuestion: "", grid: "", panels: [], gridSpec: DEFAULT_GRID, version: 0 };

function buildUserPrompt(inputs: WorkbenchInputs, grid: GridSpec) {
    return [
        "【本轮输入】",
        `- 单格画幅：${inputs.ratio}`,
        `- 分镜格数：${gridLabel(grid)}（网格按 ${grid.cols} 列 × ${grid.rows} 行排列）`,
        `- 覆盖范围（场次 / 时长 / 起止段落）：${inputs.scope.trim() || "（未填写）"}`,
        "- 成片用途：" + (inputs.usage.trim() || "（未填写）"),
        `- 基调 / 时代地点：${inputs.tone.trim() || "（未填写）"}`,
        `- 参考作品：${inputs.works.trim() || "（未填写）"}`,
        `- 禁忌：${inputs.taboos.trim() || "（未填写）"}`,
        "",
        "【剧本 / 片段】",
        inputs.script.trim(),
        "",
        buildOutputContract(grid),
    ].join("\n");
}

// ---------------------------------------------------------------------------
// 工具条按钮的注册表（工具条在节点定义里构建，拿不到组件内部状态）
// ---------------------------------------------------------------------------

export const workbenchRegistries = {
    inputs: new Map<string, WorkbenchInputs>(),
    result: new Map<string, WorkbenchResult>(),
    run: new Map<string, () => void>(),
    exportGrid: new Map<string, () => void>(),
    addPanels: new Map<string, () => void>(),
    clear: new Map<string, () => void>(),
};

export function WorkbenchContent({ ctx }: CanvasNodeContentProps) {
    const nodeId = ctx.node.id;
    const theme = ctx.theme;
    const [inputs, setInputs] = useState<WorkbenchInputs>(EMPTY_INPUTS);
    const [result, setResult] = useState<WorkbenchResult>(EMPTY_RESULT);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [error, setError] = useState("");
    const [stream, setStream] = useState("");
    const [loaded, setLoaded] = useState(false);
    const [copiedPanel, setCopiedPanel] = useState(0);

    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const abortRef = useRef<AbortController | null>(null);
    const inputsRef = useRef(inputs);
    inputsRef.current = inputs;
    const resultRef = useRef(result);
    resultRef.current = result;

    const persistInputs = (next: WorkbenchInputs) => {
        setInputs(next);
        void ctxRef.current.storage.set(`inputs:${nodeId}`, next).catch(() => undefined);
    };

    const commitResult = (next: WorkbenchResult) => {
        setResult(next);
        void ctxRef.current.storage.set(`result:${nodeId}`, next).catch(() => undefined);
        const plan = [next.understanding, next.timeline, next.notes].filter((part) => part && part.trim()).join("\n\n");
        // 分镜序列写进节点 metadata：下游「分镜出图」节点据此逐格出图（也随工程一起保存）
        ctxRef.current.updateMetadata({
            ...(plan ? { clipshotPlan: plan } : {}),
            clipshotRatio: inputsRef.current.ratio,
            clipshotGrid: next.gridSpec,
            clipshotPanels: next.panels,
            clipshotPanelCount: next.panels.length,
            ...(next.version ? { clipshotVersion: next.version } : {}),
        });
    };

    // 载入本节点上次的工作台状态（插件私有 IndexedDB，不写进工程 JSON）
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const savedInputs = await ctxRef.current.storage.get<WorkbenchInputs>(`inputs:${nodeId}`);
                const savedResult = await ctxRef.current.storage.get<WorkbenchResult>(`result:${nodeId}`);
                if (!alive) return;
                if (savedInputs && typeof savedInputs === "object") setInputs({ ...EMPTY_INPUTS, ...savedInputs });
                if (savedResult && typeof savedResult === "object") setResult({ ...EMPTY_RESULT, ...savedResult });
            } catch {
                // 读不出来就当作全新节点
            } finally {
                if (alive) setLoaded(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [nodeId]);

    const run = async () => {
        const current = inputsRef.current;
        if (!current.script.trim()) {
            setError("请先填写剧本或本次要处理的片段。");
            return;
        }
        if (!current.scope.trim()) {
            setError("请先填写本次覆盖范围（场次 / 时长 / 起止段落）——Skill 要求生成前必须确认范围。");
            return;
        }
        const grid = makeGrid(current.cols, current.rows);
        setError("");
        setStream("");
        setBusy(true);
        setStatus(`正在按 Skill 规范拆镜头（${gridLabel(grid)}）…`);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const { text } = await ctxRef.current.ai.generateText(buildUserPrompt(current, grid), {
                system: buildSystemPrompt(),
                signal: controller.signal,
                onDelta: (delta) => setStream((prev) => (prev.length > 4000 ? prev : prev + delta)),
            });
            const parsed = extractJson(text);
            if (!parsed) throw new Error("模型未返回可解析的 JSON（可在下方查看原始输出）");

            const imagePrompt = asText(parsed.imagePrompt);
            const panels = normalizePanels(parsed.panels, grid.count);
            const next: WorkbenchResult = {
                understanding: asText(parsed.understanding),
                split: asText(parsed.split),
                imagePrompt,
                timeline: asText(parsed.timelineMarkdown) || asText(parsed.timeline),
                notes: asText(parsed.notes),
                keyframeQuestion: asText(parsed.keyframeQuestion),
                grid: resultRef.current.grid,
                panels,
                gridSpec: grid,
                version: Date.now(),
            };
            commitResult(next);
            const notes: string[] = [];
            if (!panels.length) notes.push("模型未给出逐格提示词，下游无法逐格出图");
            else if (panels.length !== grid.count) notes.push(`模型返回 ${panels.length} 格，与设定 ${grid.count} 格不一致，可重跑一次`);
            const suffix = notes.length ? `（${notes.join("；")}）` : "";

            setStatus(`正在生成 ${gridLabel(grid)} 分镜总图…`);
            if (imagePrompt) {
                const { images } = await ctxRef.current.ai.generateImage(`${buildGridPrefix(grid)}\n\n${imagePrompt}`, {
                    count: 1,
                    signal: controller.signal,
                });
                if (images && images[0]) {
                    commitResult({ ...next, grid: images[0] });
                    setStatus(`分镜已生成：总图 + ${panels.length} 格${suffix}`);
                } else {
                    setStatus(`已出镜头表与逐格提示词，但未返回总图${suffix}`);
                }
            } else {
                setStatus(`已出镜头表（模型未给总图提示词）${suffix}`);
            }
            // 通知下游「分镜出图」节点按新版本开工（没有下游时是无害的空广播）
            ctxRef.current.emit(PANELS_READY_EVENT, { nodeId, version: next.version });
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                setStatus("已停止");
            } else {
                setError(errorMessage(err));
                setStatus("");
            }
        } finally {
            abortRef.current = null;
            setBusy(false);
        }
    };

    const stop = () => {
        abortRef.current?.abort();
    };

    const exportGrid = () => {
        const grid = resultRef.current.grid;
        if (!grid) {
            setError("当前没有可导出的分镜总图，请先生成分镜。");
            return;
        }
        const current = ctxRef.current;
        const spec = resultRef.current.gridSpec;
        current.applyOps([
            {
                type: "add_node",
                nodeType: "image",
                title: `分镜总图（${gridLabel(spec)}·${inputsRef.current.ratio}）`,
                position: { x: current.node.position.x + current.node.width + 96, y: current.node.position.y },
                width: 720,
                height: 720,
                metadata: {
                    content: grid,
                    mimeType: "image/png",
                    prompt: resultRef.current.imagePrompt,
                },
            },
        ]);
        setStatus("分镜总图已作为图片节点落到画布");
    };

    // 新建并连接下游「分镜出图」节点（已连接则不重复创建）
    const addPanelsNode = () => {
        const current = ctxRef.current;
        const existing = current.getDownstream().find((node) => node.type === PANELS_NODE_TYPE);
        if (existing) {
            setStatus("已有下游「分镜出图」节点，它会自动按分镜序列出图");
            return;
        }
        const id = `${PANELS_NODE_TYPE}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        current.applyOps([
            {
                type: "add_node",
                id,
                nodeType: PANELS_NODE_TYPE,
                position: { x: current.node.position.x, y: current.node.position.y + current.node.height + 96 },
            },
            { type: "connect_nodes", fromNodeId: current.node.id, toNodeId: id },
        ]);
        setStatus(resultRef.current.panels.length ? "已创建并连接「分镜出图」节点，正在自动出图" : "已创建并连接「分镜出图」节点，生成分镜后会自动出图");
    };

    const clearAll = () => {
        abortRef.current?.abort();
        setError("");
        setStatus("");
        setStream("");
        commitResult(EMPTY_RESULT);
    };

    const copyText = (text: string, message: string) => {
        if (!text) {
            setError("当前没有可复制的内容。");
            return;
        }
        void navigator.clipboard?.writeText(text).then(() => setStatus(message)).catch(() => undefined);
    };

    useEffect(() => {
        workbenchRegistries.inputs.set(nodeId, inputs);
        workbenchRegistries.result.set(nodeId, result);
        workbenchRegistries.run.set(nodeId, () => void run());
        workbenchRegistries.exportGrid.set(nodeId, exportGrid);
        workbenchRegistries.addPanels.set(nodeId, addPanelsNode);
        workbenchRegistries.clear.set(nodeId, clearAll);
        return () => {
            workbenchRegistries.inputs.delete(nodeId);
            workbenchRegistries.result.delete(nodeId);
            workbenchRegistries.run.delete(nodeId);
            workbenchRegistries.exportGrid.delete(nodeId);
            workbenchRegistries.addPanels.delete(nodeId);
            workbenchRegistries.clear.delete(nodeId);
        };
    });

    const grid = makeGrid(inputs.cols, inputs.rows);
    const activePreset = GRID_PRESETS.find((preset) => preset.cols === grid.cols && preset.rows === grid.rows)?.id || "custom";
    const downstreamPanels = ctx.getDownstream().find((node) => node.type === PANELS_NODE_TYPE);
    const styles = accentStyles(theme);
    const { labelStyle, fieldStyle, chipStyle, buttonStyle } = styles;

    const missing = [!inputs.script.trim() && "剧本 / 片段", !inputs.scope.trim() && "覆盖范围"].filter(Boolean) as string[];

    return (
        <div
            data-canvas-no-zoom
            style={{
                position: "relative",
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                background: theme.node.panel,
                color: theme.node.text,
                borderRadius: 16,
                overflow: "hidden",
                outline: "2px solid #8b5cf6",
                outlineOffset: -2,
            }}
        >
            {/* 标题栏：本节点唯一可拖拽区域（内容区已阻止指针冒泡，避免操作表单时误拖节点） */}
            <div style={titleBarStyle(theme)}>
                <span style={{ flex: "0 0 auto" }}>🎬 分镜工作台 · 拖拽标题栏移动节点</span>
                <span style={statusTextStyle()} title={status || error}>
                    {error || status}
                </span>
            </div>

            {/* 内容区：阻止冒泡 → 不触发节点拖拽；配合 data-canvas-no-zoom 让画布快捷键让位于输入 */}
            <div
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                style={bodyStyle()}
            >
                <div>
                    <span style={labelStyle}>剧本 / 片段 *（必填）</span>
                    <textarea
                        value={inputs.script}
                        onChange={(event) => persistInputs({ ...inputsRef.current, script: event.target.value })}
                        placeholder="粘贴剧本正文或本次要处理的明确片段…"
                        rows={5}
                        style={{ ...fieldStyle, resize: "vertical", minHeight: 72, lineHeight: 1.6 }}
                    />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 10 }}>
                    <div>
                        <span style={labelStyle}>单格画幅 *</span>
                        <select value={inputs.ratio} onChange={(event) => persistInputs({ ...inputsRef.current, ratio: event.target.value })} style={fieldStyle}>
                            {RATIOS.map((ratio) => (
                                <option key={ratio} value={ratio}>
                                    {ratio === "16:9" ? "横屏 16:9" : ratio === "3:4" ? "竖屏 3:4" : "竖屏 9:16"}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <span style={labelStyle}>覆盖范围 *（场次 / 时长 / 起止段落）</span>
                        <input
                            value={inputs.scope}
                            onChange={(event) => persistInputs({ ...inputsRef.current, scope: event.target.value })}
                            placeholder="例：第 3—7 场，约 45 秒"
                            style={fieldStyle}
                        />
                    </div>
                </div>

                <div>
                    <span style={labelStyle}>分镜格数 *（默认九宫格 3×3 = 9 格）</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {GRID_PRESETS.map((preset) => (
                            <button
                                key={preset.id}
                                type="button"
                                style={chipStyle(activePreset === preset.id)}
                                onClick={() => persistInputs({ ...inputsRef.current, cols: preset.cols, rows: preset.rows })}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                        <span style={{ fontSize: 11, color: theme.node.muted }}>自定义</span>
                        <select
                            value={grid.cols}
                            onChange={(event) => persistInputs({ ...inputsRef.current, cols: Number(event.target.value) })}
                            style={{ ...fieldStyle, width: 66 }}
                        >
                            {GRID_SIDES.map((side) => (
                                <option key={side} value={side}>
                                    {side} 列
                                </option>
                            ))}
                        </select>
                        <span style={{ fontSize: 11, color: theme.node.muted }}>×</span>
                        <select
                            value={grid.rows}
                            onChange={(event) => persistInputs({ ...inputsRef.current, rows: Number(event.target.value) })}
                            style={{ ...fieldStyle, width: 66 }}
                        >
                            {GRID_SIDES.map((side) => (
                                <option key={side} value={side}>
                                    {side} 行
                                </option>
                            ))}
                        </select>
                        <span style={{ fontSize: 11.5, color: theme.node.muted }}>
                            共 <strong style={{ color: theme.node.text }}>{grid.count}</strong> 格 · 单格 {inputs.ratio}
                        </span>
                    </div>
                </div>

                <details>
                    <summary style={{ cursor: "pointer", fontSize: 11.5, color: theme.node.muted }}>高级选项（用途 / 基调 / 参考作品 / 禁忌）</summary>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                        <div>
                            <span style={labelStyle}>成片用途</span>
                            <input value={inputs.usage} onChange={(event) => persistInputs({ ...inputsRef.current, usage: event.target.value })} placeholder="叙事影片 / 广告 / MV / 短剧" style={fieldStyle} />
                        </div>
                        <div>
                            <span style={labelStyle}>基调 / 时代地点</span>
                            <input value={inputs.tone} onChange={(event) => persistInputs({ ...inputsRef.current, tone: event.target.value })} placeholder="例：2000 年代南方县城，阴冷" style={fieldStyle} />
                        </div>
                        <div>
                            <span style={labelStyle}>参考作品</span>
                            <input value={inputs.works} onChange={(event) => persistInputs({ ...inputsRef.current, works: event.target.value })} placeholder="仅作镜头语言转译参考" style={fieldStyle} />
                        </div>
                        <div>
                            <span style={labelStyle}>禁忌</span>
                            <input value={inputs.taboos} onChange={(event) => persistInputs({ ...inputsRef.current, taboos: event.target.value })} placeholder="例：不要出现血腥" style={fieldStyle} />
                        </div>
                    </div>
                </details>

                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" onClick={() => void run()} disabled={busy} style={buttonStyle(true, busy)}>
                        {busy ? "生成中…" : "生成分镜"}
                    </button>
                    {busy ? (
                        <button type="button" onClick={stop} style={buttonStyle()}>
                            停止
                        </button>
                    ) : null}
                    <button type="button" onClick={exportGrid} disabled={!result.grid} style={buttonStyle(false, !result.grid)}>
                        导出总图到画布
                    </button>
                    <button type="button" onClick={addPanelsNode} style={buttonStyle()}>
                        {downstreamPanels ? "已连接分镜出图" : "+ 分镜出图节点"}
                    </button>
                    <button type="button" onClick={() => copyText(result.imagePrompt, "分镜总图提示词已复制")} disabled={!result.imagePrompt} style={buttonStyle(false, !result.imagePrompt)}>
                        复制总图提示词
                    </button>
                    <button type="button" onClick={clearAll} style={buttonStyle()}>
                        清空
                    </button>
                    {missing.length && !busy ? <span style={{ fontSize: 11, color: theme.node.muted }}>还缺：{missing.join("、")}</span> : null}
                </div>

                {!loaded ? <div style={{ fontSize: 11.5, color: theme.node.muted }}>正在读取本节点上次的状态…</div> : null}

                {error ? (
                    <div style={{ fontSize: 11.5, color: "#f87171", background: "rgba(248,113,113,.12)", border: "1px solid rgba(248,113,113,.35)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.6 }}>
                        {error}
                        <div style={{ marginTop: 4, color: theme.node.muted }}>提示：文本与图像能力来自画布「配置与用户偏好 → 渠道」，需先在渠道里配置可用的文本与图像模型。</div>
                    </div>
                ) : null}

                {busy && stream ? (
                    <details open>
                        <summary style={{ cursor: "pointer", fontSize: 11.5, color: theme.node.muted }}>模型实时输出（截断显示）</summary>
                        <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, lineHeight: 1.6, maxHeight: 160, overflow: "auto", margin: "6px 0 0", color: theme.node.muted }}>{stream}</pre>
                    </details>
                ) : null}

                {result.understanding ? (
                    <section>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.node.muted, marginBottom: 4 }}>创作理解</div>
                        <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{result.understanding}</div>
                    </section>
                ) : null}

                {result.split ? (
                    <section>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.node.muted, marginBottom: 4 }}>长剧本拆分建议</div>
                        <MarkdownTables theme={theme} markdown={result.split} />
                    </section>
                ) : null}

                {result.grid ? (
                    <section>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.node.muted, marginBottom: 4 }}>
                            分镜总图（{gridLabel(result.gridSpec)} · 单格 {inputs.ratio}）
                        </div>
                        <img src={result.grid} alt="分镜总图" style={{ width: "100%", borderRadius: 8, border: `1px solid ${theme.node.stroke}`, display: "block" }} />
                    </section>
                ) : null}

                {result.panels.length ? (
                    <section>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 11.5, fontWeight: 600, color: theme.node.muted }}>逐格图像提示词（{result.panels.length} 格，供下游出图）</span>
                            <button type="button" style={chipStyle()} onClick={() => copyText(result.panels.map((panel) => `Panel ${String(panel.index).padStart(2, "0")}\n${panel.prompt}`).join("\n\n"), "已复制全部逐格提示词")}>
                                复制全部
                            </button>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {result.panels.map((panel) => (
                                <details key={panel.index} style={{ border: `1px solid ${theme.node.stroke}`, borderRadius: 8, padding: "6px 8px" }}>
                                    <summary style={{ cursor: "pointer", fontSize: 11.5 }}>
                                        <strong style={{ color: "#8b5cf6" }}>Panel {String(panel.index).padStart(2, "0")}</strong>
                                        {panel.timecode ? <span style={{ color: theme.node.muted }}> · {panel.timecode}</span> : null}
                                        {panel.shot ? <span style={{ color: theme.node.muted }}> · {panel.shot}</span> : null}
                                    </summary>
                                    <div style={{ fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 6, color: theme.node.muted }}>{panel.prompt}</div>
                                    <button
                                        type="button"
                                        style={{ ...chipStyle(), marginTop: 6 }}
                                        onClick={() => {
                                            setCopiedPanel(panel.index);
                                            copyText(panel.prompt, `Panel ${String(panel.index).padStart(2, "0")} 提示词已复制`);
                                        }}
                                    >
                                        {copiedPanel === panel.index ? "已复制" : "复制本格"}
                                    </button>
                                </details>
                            ))}
                        </div>
                        <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: theme.node.muted, background: theme.node.faint, border: `1px solid ${theme.node.stroke}`, borderRadius: 8, padding: "8px 10px" }}>
                            {downstreamPanels
                                ? "已连接「分镜出图」节点：改动格数或重新生成后，它会按分镜序列自动逐格出图。"
                                : "连接一个「分镜出图」节点即可自动按分镜序列逐格出图（点上方「+ 分镜出图节点」一键创建并连接）。"}
                        </div>
                    </section>
                ) : null}

                {result.timeline ? (
                    <section>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.node.muted, marginBottom: 4 }}>时间线分镜解读表</div>
                        <MarkdownTables theme={theme} markdown={result.timeline} />
                    </section>
                ) : null}

                {result.notes ? (
                    <section>
                        <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.node.muted, marginBottom: 4 }}>特殊镜头与转场</div>
                        <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{result.notes}</div>
                    </section>
                ) : null}

                {result.keyframeQuestion ? (
                    <div style={{ fontSize: 11.5, lineHeight: 1.7, color: theme.node.muted, background: theme.node.faint, border: `1px solid ${theme.node.stroke}`, borderRadius: 8, padding: "8px 10px" }}>
                        <strong style={{ color: theme.node.text }}>Skill 约定的下一步：</strong>
                        {result.keyframeQuestion}
                        <div style={{ marginTop: 4 }}>关键帧阶段需要你另行提供人物 / 场景 / 服装 / 道具 / 风格素材，本节点当前只交付分镜阶段。</div>
                    </div>
                ) : null}

                {!result.understanding && !result.grid && !busy && loaded ? (
                    <div style={{ fontSize: 11.5, color: theme.node.muted, lineHeight: 1.7 }}>
                        规则来源：<span style={{ color: "#8b5cf6" }}>cinematic-storyboard-design</span>（https://github.com/TanShilongMario/clipshot，MIT）。填写剧本与覆盖范围后点「生成分镜」，节点会用 SKILL.md 与 references 原文驱动文本模型拆镜头，
                        再调用图像模型出「{gridLabel(grid)}」制作型分镜总图；同一份逐格提示词会交给下游「分镜出图」节点按序列出图。
                    </div>
                ) : null}
            </div>
        </div>
    );
}
