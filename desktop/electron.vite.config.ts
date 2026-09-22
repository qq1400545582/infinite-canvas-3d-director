import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// 桌面壳只构建 main + preload；renderer 就是 web/ 的构建产物（由 scripts/build-web.mjs 拷贝到 resources/web-dist）。
// 不引入任何打包器对 web/ 的重编译，保证「一份前端、两条分发」。
export default defineConfig({
    main: {
        entry: "src/main.ts",
        build: {
            rollupOptions: {
                // web/vite-plugins/*.ts 会以相对路径被 main 直接 import 并打进 bundle；
                // 其仅 import node:* 与 `import type` 的 vite 类型，运行时零外部依赖。
                external: ["electron", "electron-updater", /^node:/],
            },
        },
    },
    preload: {
        entry: "src/preload.ts",
    },
    renderer: {
        // 不使用 electron-vite 的 renderer 构建
        build: {
            rollupOptions: {
                input: resolve(__dirname, "empty.html"),
            },
        },
    },
});
