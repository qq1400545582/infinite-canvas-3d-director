// 构建 DirectorDesk（白模预演台）独立应用，产出到 web/public/director-desk/。
// 该目录随仓库提交，运行时由宿主以同源 /director-desk/ 直接托管，iframe 即同源加载。
//
// 依赖前置（在你本机、能访问 GitHub 的环境执行）：
//   1) git clone https://github.com/mangfufu/director-desk 到 app/（或任意目录，用 DIRECTOR_DESK_SRC 指定）
//   2) cd <app> && npm install   （DirectorDesk 用 Vite 8，需要 Node ≥ 22.12，本机 22.22 满足）
//   3) 回到本插件目录运行：npm run build:app
//
// 为什么用 --base=./：DirectorDesk 是纯前端 SPA，内嵌到画布子路径 /director-desk/ 下时，
// 资源必须用相对路径引用（./assets/... → /director-desk/assets/...），否则会被解析到站点根导致 404。
// 这里用 CLI --base 覆盖，避免改动 vendor 源码的 vite.config.ts。
import { spawnSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
// 源码位置：默认 app/，可用环境变量 DIRECTOR_DESK_SRC 覆盖（指向你 clone 下来的仓库根）。
const appDir = process.env.DIRECTOR_DESK_SRC ? resolve(process.env.DIRECTOR_DESK_SRC) : join(root, "app");
const outDir = join(root, "..", "..", "..", "web", "public", "director-desk");

if (!existsSync(appDir)) {
    console.error(`[director-desk] 找不到 DirectorDesk 源码目录：${appDir}`);
    console.error("请先 git clone https://github.com/mangfufu/director-desk 到 app/，或设置 DIRECTOR_DESK_SRC 指向仓库根目录。");
    process.exit(1);
}

const viteBin = resolve(appDir, "node_modules/vite/bin/vite.js");
if (!existsSync(viteBin)) {
    console.error(`[director-desk] 未找到 vite，请先在 ${appDir} 下执行 npm install。`);
    process.exit(1);
}

// 输出目录在 app 源码之外，vite 不会自动清空；先手动清空以保证干净产物。
rmSync(outDir, { recursive: true, force: true });

const result = spawnSync(process.execPath, [viteBin, "build", "--base", "./", "--outDir", outDir], {
    cwd: appDir,
    stdio: "inherit",
});

if (result.status !== 0) {
    console.error("[director-desk] app build failed");
    process.exit(result.status ?? 1);
}

console.log(`[director-desk] app built → web/public/director-desk/`);
