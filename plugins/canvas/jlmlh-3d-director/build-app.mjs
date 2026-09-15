// 构建 jlmlh-3d-director（3D 导演台）独立应用，产出到 web/public/jlmlh-3d-director/。
// 该目录随仓库提交，运行时由宿主以同源 /jlmlh-3d-director/ 直接托管，iframe 即同源加载。
//
// 依赖：先在 app/ 下 `npm install`（three / @react-three/fiber / vite 等），再运行本脚本。
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const appDir = join(root, "app");
const outDir = join(root, "..", "..", "..", "web", "public", "jlmlh-3d-director");

// 输出目录在 app 源码之外，vite 不会自动清空；先手动清空以保证干净产物。
rmSync(outDir, { recursive: true, force: true });

// 直接调用本地 vite 的 bin（用当前 node 运行），避免依赖 npx / PATH 解析。
//
// 注意：这里**不要**传 --base 覆盖。app/vite.config.ts 是官方原文件，其 base 为 "./"（相对路径），
// 产物里的资源引用形如 ./assets/xxx.js，浏览器会相对文档 URL 解析为 /jlmlh-3d-director/assets/xxx.js。
// 相对 base 比写死绝对路径更稳：宿主若部署在子路径下（VITE_BASE 非根）依然可用。
const viteBin = resolve(appDir, "node_modules/vite/bin/vite.js");
const result = spawnSync(process.execPath, [viteBin, "build", "--outDir", outDir], {
    cwd: appDir,
    stdio: "inherit",
});

if (result.status !== 0) {
    console.error("[jlmlh-3d-director] app build failed");
    process.exit(result.status ?? 1);
}

console.log(`[jlmlh-3d-director] app built → web/public/jlmlh-3d-director/`);
