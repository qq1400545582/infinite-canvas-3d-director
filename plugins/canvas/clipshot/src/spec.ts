// 分镜规范层（clipshot）
// -----------------------------------------------------------------------------
// 本文件只做一件事：把 upstream 的「3×3 九宫格」相关文字**参数化**，其余创作规则继续保持
// 逐字原文。这样默认（3 列 × 3 行 = 9 格）时拼出的字符串与 v1.0.0 完全一致（逐字节），
// 仅在用户主动改成非 3×3 时才出现差异。
//
// 原文出处（见 src/prompts.ts，由 tools/gen-prompts.mjs 逐字内联）：
//   - references/visual-production.md 的「生成提示词结构」与全局禁项
//   - references/deliverable-schema.md 的交付字段
//
// 参数化改写的只有三处，均为「格数」本身，不涉及任何创作规则：
//   1. 交付物行：grid 尺寸与格数（3x3 / nine → NxM / <英文数词>）
//   2. 阅读顺序行：Panel 01-09 → Panel 01-<补零格数>
//   3. 输出契约：逐格条目编号范围，并新增 panels 逐格提示词数组

export type GridSpec = { cols: number; rows: number; count: number };

// 单次最多出图格数（同时限制网格规模，避免一次请求爆掉模型的网格理解能力）
export const MAX_PANELS = 16;
export const MIN_GRID_SIDE = 1;
export const MAX_GRID_SIDE = 4;

export const DEFAULT_GRID: GridSpec = { cols: 3, rows: 3, count: 9 };

export function makeGrid(cols: number, rows: number): GridSpec {
    const c = Math.min(MAX_GRID_SIDE, Math.max(MIN_GRID_SIDE, Math.round(cols) || 1));
    const r = Math.min(MAX_GRID_SIDE, Math.max(MIN_GRID_SIDE, Math.round(rows) || 1));
    return { cols: c, rows: r, count: Math.min(MAX_PANELS, c * r) };
}

// 预设（含默认的九宫格）
export const GRID_PRESETS: { id: string; label: string; cols: number; rows: number }[] = [
    { id: "2x2", label: "4 格 2×2", cols: 2, rows: 2 },
    { id: "3x2", label: "6 格 3×2", cols: 3, rows: 2 },
    { id: "3x3", label: "9 格 3×3（默认·九宫格）", cols: 3, rows: 3 },
    { id: "4x3", label: "12 格 4×3", cols: 4, rows: 3 },
    { id: "4x4", label: "16 格 4×4", cols: 4, rows: 4 },
];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];

function numberWord(value: number) {
    return NUMBER_WORDS[value] || String(value);
}

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

// 与 v1.0.0 的 GRID_PREFIX 第 3 行起逐字一致（原文未改）。
const GRID_PREFIX_TAIL = [
    "Medium: white or warm-white paper; black pen/pencil/ink construction lines plus flat marker or limited color-block lighting masses; NOT line art only.",
    "Figures: construction figures first (camera and pose readable; body line, weight, support foot and contact points readable); simple graphic facial features only when the shot needs them; clear hand poses and finger articulation for any important hand action; identify characters by body mass, proportion, silhouette and costume color blocks only.",
    "One restrained highlight color (red) only: solid red arrow for figure movement, red arrow at the frame edge with a very short label for camera movement, thin red dashed line for sight lines only when space is hard to read. No decorative arrows.",
    "Every panel must show where the light comes from and what shape it forms, as large flat light/shadow masses with readable shadow landing; light must be a graphic structure in space, not per-object 3D shading.",
    "Keep in-panel text minimal: panel number, very short timecode, necessary camera-movement label only.",
    "Reference images are continuity references only, not rendering-style references. redraw as ink construction figures with flat marker lighting; inherit body proportion, costume blocks, and graphic light direction; keep simple graphic faces and clear hand poses where the shot needs them; discard photographic finish.",
    "Forbidden: merged panels, unequal frames, extra panels, missing panels, long captions, line-art-only panels, missing light and shadow masses, decorative arrows, inconsistent body proportions, photorealism, photographic lighting, cinematic still, film still, 3D render, Unreal Engine, Octane, subsurface skin, pores, realistic hair, fabric microtexture, metal reflection, glass refraction, depth of field, bokeh, lens flare, volumetric light, god rays, HDR bloom, film grain used as realism, camera-shutter motion blur, color grade, concept-art finish, matte painting, polished illustration, character illustration, blob hands on close-ups.",
];

/**
 * 分镜总图（一张 N×M 网格）的图像提示词前缀。
 * grid = 3×3 时与 v1.0.0 的 GRID_PREFIX 逐字节一致（见 tools/../ 校验脚本）。
 */
export function buildGridPrefix(grid: GridSpec) {
    const { cols, rows, count } = grid;
    return [
        `Deliverable: one production storyboard sheet, a strict equal ${cols}x${rows} grid (${cols} columns x ${rows} rows) containing exactly ${numberWord(count)} equal panels.`,
        `Panel 01-${pad2(count)} reading order left-to-right, top-to-bottom. Panels share identical outer size, identical inner aspect ratio and identical spacing; clear white gutters and a crisp black border legible in thumbnail.`,
        ...GRID_PREFIX_TAIL,
    ].join("\n");
}

const RATIO_HINTS: Record<string, string> = {
    "16:9": "16:9 landscape",
    "3:4": "3:4 portrait",
    "9:16": "9:16 vertical",
};

/**
 * 单格分镜（逐格出图）的图像提示词前缀：视觉语言与全局禁项沿用原文，
 * 只把「一张网格纸」换成「单独一帧」（同样不引入任何新的表现风格）。
 */
export function buildPanelPrefix(ratio?: string) {
    const tail = [...GRID_PREFIX_TAIL];
    tail[4] = "Keep in-panel text minimal: a very short timecode and the necessary camera-movement label only.";
    const lines = [
        "Deliverable: one single production storyboard panel — a single frame, NOT a sheet: no grid, no gutters, no panel-number strip, no outer sheet border.",
        "The single panel fills the frame edge to edge at one consistent aspect ratio and stays readable at thumbnail size.",
        ...tail,
    ];
    const hint = ratio ? RATIO_HINTS[ratio] : undefined;
    if (hint) lines.push(`Output frame: one single ${hint} panel.`);
    return lines.join("\n");
}

// 运行环境适配（不改任何创作规则，只补充「本节点如何交付」）。格数相关文字随 grid 变化。
export function buildOutputContract(grid: GridSpec) {
    const { cols, rows, count } = grid;
    return [
        "【运行环境与输出契约（本节点调用，务必遵守；不改变上述任何创作规则）】",
        "1. 上文的 SKILL.md 与本阶段所需 references 已全部提供，你无需、也不要尝试读取任何文件或索要路径。",
        `2. 本次只执行分镜阶段（Skill“执行状态机”中的 READ 到 DELIVER STORYBOARD 与 OFFER KEYFRAMES），不要生成成片关键帧，也不要读取 keyframe-production 相关流程。`,
        `3. 图像由调用方生成，不由你生成：你必须输出可直接交给图像模型的提示词（一张 ${gridLabel(grid)} 分镜总图 + 每格单独一帧）。`,
        `4. 本次分镜总图规格由调用方指定：${cols} 列 × ${rows} 行，共 ${count} 格（visual-production 的 3×3 九宫格规格按此等比改写，其余视觉语言与禁项保持原文不变）。`,
        "5. 只输出一个 JSON 对象：不要输出 JSON 之外的任何文字，不要使用 Markdown 代码围栏。字段与要求：",
        "{",
        '  "understanding": 字符串，按 deliverable-schema 的“简短创作理解”：核心冲突、情绪从何处转向何处、主要空间关系、主导视觉母题，一小段。',
        '  "split": 字符串，长剧本拆分建议的紧凑 Markdown 表格（deliverable-schema 规定的 5 列）；不需要拆分时为空字符串。',
        `  "imagePrompt": 字符串，完整 ${cols}×${rows} 分镜总图提示词：按 visual-production 的“生成提示词结构”7 点组织，并把 Panel 01—${pad2(count)} 逐格写清（每格至少写主体位置、镜头高度/角度、景别、可见动作、环境锚点、运动方向、主光方位和光的形态）。以英文为主。结尾必须包含全局禁项与 “Reference images are continuity references only, not rendering-style references.”。`,
        `  "panels": 数组，长度必须正好是 ${count}，按阅读顺序（左→右、上→下）逐格给出；每项形如：`,
        '    { "index": 1, "timecode": "与时间线表一致的时间码", "shot": "镜号 + 景别/机位简述", "prompt": "该格的独立文生图提示词（英文）" }',
        "    prompt 必须能独立成画：写清主体与人物、景别、机位高度与角度、可见动作、环境锚点、运动方向、主光方位与光的形态，并带上固定视觉语言（构造线 + 平涂明暗块 + 唯一红色标注）。不要出现“同上一格”“见第 N 格”这类指代，也不要在 prompt 里写镜号或时间码。",
        '  "timelineMarkdown": 字符串，时间线分镜解读表：严格使用 deliverable-schema 规定的 11 列 Markdown 表格（时间码/镜号/时长/景别·机位·焦感/画面与表演/构图与色彩/运镜·人物动线/声音·对白/转场/表达内容与内涵/连续性提示），每格一行；连续运镜节点按 a/b/c 规则计时。',
        '  "notes": 字符串，特殊镜头与转场说明的短条目（镜号、触发时机、执行方式、叙事意义、拍摄风险或连续性要求）；没有则为空字符串。',
        '  "keyframeQuestion": 字符串，严格采用 deliverable-schema“分镜完成后的关键帧询问”给出的那句中文收尾提问。',
        "}",
        "6. 若输入信息不足以确定画幅、范围或人物设定，仍需按 Skill 要求指出缺失项，但仍以该 JSON 结构输出：把追问写进 understanding，其余字段给出基于已确认信息的方案。",
    ].join("\n");
}

export function gridLabel(grid: GridSpec) {
    return `${grid.cols}×${grid.rows}（${grid.count} 格）`;
}

// 从模型返回的 panels 里稳健地取出逐格提示词。
export type PanelPrompt = { index: number; timecode: string; shot: string; prompt: string };

export function normalizePanels(value: unknown, expected: number): PanelPrompt[] {
    if (!Array.isArray(value)) return [];
    const panels: PanelPrompt[] = [];
    value.forEach((item, position) => {
        if (!item || typeof item !== "object") return;
        const record = item as Record<string, unknown>;
        const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
        if (!prompt) return;
        const rawIndex = record.index;
        const parsed = typeof rawIndex === "number" ? rawIndex : Number.parseInt(String(rawIndex ?? ""), 10);
        panels.push({
            index: Number.isFinite(parsed) && parsed > 0 ? parsed : position + 1,
            timecode: typeof record.timecode === "string" ? record.timecode.trim() : "",
            shot: typeof record.shot === "string" ? record.shot.trim() : "",
            prompt,
        });
    });
    // 以期望格数为准截断（模型偶尔多给），不足则原样保留（不伪造内容，由界面提示）
    return expected > 0 ? panels.slice(0, expected) : panels;
}
