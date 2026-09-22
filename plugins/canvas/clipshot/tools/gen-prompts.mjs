// 从开源项目 clipshot（TanShilongMario/clipshot, MIT）的提示词/规范文件逐字内联，
// 生成 src/prompts.ts。上游更新后重新生成即可，保证节点内的规则与源码一致。
//
// 用法：node tools/gen-prompts.mjs <clipshot 仓库根目录>
//
// 产物路径固定为 「本脚本目录/../src/prompts.ts」——刻意不通过 argv 传输出路径，
// 以免中文仓库路径经原生进程 argv 被 ANSI/GBK 错解（本机已知坑）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = process.argv[2];
if (!srcRoot) {
    console.error("用法: node tools/gen-prompts.mjs <clipshot 仓库根目录>");
    process.exit(1);
}
const root = resolve(srcRoot);

// 常量名 -> 仓库内相对路径。前 5 项是节点实际发送给模型的上下文（分镜阶段）；
// 后 2 项一并内联留存（agents 元数据 + 关键帧阶段规范），供后续扩展。
const FILES = [
    ["SKILL_MD", "SKILL.md"],
    ["REF_CINEMATIC_LANGUAGE", "references/cinematic-language.md"],
    ["REF_ACTION_CINEMATOGRAPHY", "references/action-cinematography.md"],
    ["REF_VISUAL_PRODUCTION", "references/visual-production.md"],
    ["REF_DELIVERABLE_SCHEMA", "references/deliverable-schema.md"],
    ["REF_KEYFRAME_PRODUCTION", "references/keyframe-production.md"],
    ["AGENTS_OPENAI_YAML", "agents/openai.yaml"],
];

const chunks = [];
const meta = [];
for (const [constName, rel] of FILES) {
    const text = await readFile(join(root, rel), "utf8");
    meta.push(`${constName} ← ${rel}（${Buffer.byteLength(text, "utf8")} bytes）`);
    chunks.push(`// 源文件: ${rel}\nexport const ${constName} = ${JSON.stringify(text)};\n`);
}

const header =
    [
        "// 本文件由 tools/gen-prompts.mjs 自动生成，请勿手改。",
        "// 内容逐字取自开源项目 clipshot（TanShilongMario/clipshot, MIT License）的提示词与规范文件，",
        "// 用于在画布节点内复现 cinematic-storyboard-design Skill 的完整规则。",
        "// 重新生成：node tools/gen-prompts.mjs <clipshot 仓库根目录>",
        "/*",
        ...meta.map((line) => ` * ${line}`),
        " */",
        "",
    ].join("\n") + "\n";

const out = join(here, "..", "src", "prompts.ts");
await mkdir(dirname(out), { recursive: true });
await writeFile(
    out,
    header + chunks.join("\n") + `\nexport const CLIPSHOT_SKILL_NAME = "cinematic-storyboard-design";\nexport const CLIPSHOT_SOURCE = "https://github.com/TanShilongMario/clipshot";\n`,
    "utf8",
);

console.log(`wrote ${out}`);
console.log(meta.join("\n"));
