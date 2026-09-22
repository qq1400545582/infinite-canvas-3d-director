// 构建 OpenReel（pnpm monorepo）独立应用，产出到 web/public/openreel-video/。
// 该目录随仓库提交，运行时由宿主以同源 /openreel-video/ 直接托管，iframe 即同源加载。
//
// OpenReel 官方构建链（根 package.json）：
//   build = pnpm build:wasm && pnpm --filter @openreel/web build
// 其中 build:wasm 用 AssemblyScript(asc) 编译 packages/core 下的 fft/wav/beat-detection，
// 产物（*.wasm）未随仓库提交，因此【必须先跑 build:wasm】，否则 web 构建会因缺少 wasm 失败。
//
// 关于 base：app/apps/web/vite.config.ts 新增了 OPENREEL_BASE_RELATIVE 开关，
// 打开后 base 变为 "./"，保证产物资源在 /openreel-video/ 子路径下正确解析。
// 该开关【不】触发 strip-ffmpeg / prune-fonts（那是 OPENREEL_DESKTOP=1 的行为），
// 因此 ffmpeg 多线程 core、字体与全部编辑能力保持不变。
import { spawnSync } from "node:child_process";
import { rmSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const appDir = join(root, "app");
const webDist = join(appDir, "apps", "web", "dist");
const outDir = join(root, "..", "..", "..", "web", "public", "openreel-video");

if (!existsSync(appDir)) {
    console.error("[openreel-video] 未找到 app/ 源码：OpenReel 完整仓库应 vendor 在 app/（见 README.md）");
    process.exit(1);
}

// 解析 pnpm：优先 PNPM_BIN，其次 corepack pnpm（遵守 app/package.json 的 packageManager 固定版本）
function resolvePnpm() {
    if (process.env.PNPM_BIN) return { cmd: process.env.PNPM_BIN, base: [] };
    const corepack = process.env.COREPACK_BIN;
    if (corepack && existsSync(corepack)) {
        return { cmd: process.execPath, base: [corepack, "pnpm"] };
    }
    return { cmd: "pnpm", base: [] };
}

const { cmd, base } = resolvePnpm();

function run(args, extraEnv = {}) {
    console.log(`\n[openreel-video] $ ${cmd} ${[...base, ...args].join(" ")}`);
    const r = spawnSync(cmd, [...base, ...args], {
        cwd: appDir,
        stdio: "inherit",
        env: { ...process.env, ...extraEnv },
    });
    if (r.status !== 0) {
        console.error(`[openreel-video] 命令失败：${args.join(" ")}`);
        process.exit(r.status ?? 1);
    }
}

// 1) 安装依赖（pnpm workspace）
if (!existsSync(join(appDir, "node_modules"))) {
    run(["install", "--no-frozen-lockfile", "--network-concurrency=24"]);
} else {
    console.log("[openreel-video] node_modules 已存在，跳过 install（如需重装请先删除 app/node_modules）");
}

// 2) 官方构建链：build:wasm（asc 编译 core 的 wasm）+ web 构建（tsc --noEmit && vite build）
//    带上 OPENREEL_BASE_RELATIVE=1 以产出子路径可直接托管的相对资源路径。
run(["build"], { OPENREEL_BASE_RELATIVE: "1" });

if (!existsSync(webDist)) {
    console.error(`[openreel-video] 未生成构建产物：${webDist}`);
    process.exit(1);
}

// 3) 拷贝到同源静态目录（位于 app 源码之外，先清空保证干净产物）
rmSync(outDir, { recursive: true, force: true });
cpSync(webDist, outDir, { recursive: true });
console.log(`\n[openreel-video] 应用已构建 → web/public/openreel-video/`);
