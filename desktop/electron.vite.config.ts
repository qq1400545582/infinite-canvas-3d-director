import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// 桌面壳只构建 main + preload；renderer 就是 web/ 的构建产物（由 scripts/build-web.mjs 拷贝到 resources/web-dist）。
// 不引入任何打包器对 web/ 的重编译，保证「一份前端、两条分发」。
export default defineConfig({
    main: {
        // electron-vite 不认顶层 entry：入口必须写在 build.lib.entry（或 build.rollupOptions.input）。
        build: {
            lib: { entry: "src/main.ts" },
            rollupOptions: {
                // web/vite-plugins/*.ts 会以相对路径被 main 直接 import 并打进 bundle；
                // 其仅 import node:* 与 `import type` 的 vite 类型，运行时零外部依赖。
                external: ["electron", "electron-updater", /^node:/],
            },
        },
    },
    preload: {
        build: {
            lib: { entry: "src/preload.ts" },
        },
    },
    renderer: {
        // 不使用 electron-vite 的 renderer 构建：窗口内容全部由本机 HTTP 服务（127.0.0.1:PORT）提供。
        // 这里只保留一个空占位页，避免 electron-vite 因缺少 renderer 入口而中止构建。
        // 必须显式把 root 指到 desktop/，否则 input 的绝对路径会被算成 "../../empty.html" 而报错。
        root: __dirname,
        build: {
            outDir: "out/renderer",
            rollupOptions: {
                input: resolve(__dirname, "empty.html"),
            },
        },
    },
});
