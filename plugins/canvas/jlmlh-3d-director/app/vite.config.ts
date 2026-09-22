import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Windows 上 new URL().pathname 形如 "/D:/..."，前导斜杠会让 Vite 解析成 "D:/D:/..."。
// 去掉盘符前的斜杠，避免 dev server 的 fs.allow 把真实路径判为越界（403 Restricted）。
const toFsPath = (url: URL) => decodeURIComponent(url.pathname.replace(/^\/(?=[A-Za-z]:\/)/, ""));

export default defineConfig({
  base: "./",
  assetsInclude: ["**/*.fbx", "**/*.obj"],
  plugins: [react()],
  server: {
    fs: {
      allow: [
        toFsPath(new URL(".", import.meta.url)),
        toFsPath(new URL("../模型库", import.meta.url)),
      ],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    pool: "threads",
    maxWorkers: 1,
    setupFiles: "./src/test/setup.ts",
  },
});
