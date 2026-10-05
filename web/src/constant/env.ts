export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// 顶栏 GitHub 入口指向的项目仓库：默认本二开仓库，可用 VITE_REPO_URL 覆盖。
export const REPO_URL = (import.meta.env.VITE_REPO_URL || "https://github.com/qq1400545582/infinite-canvas-3d-director").trim();

// Official plugin registry URL: CI publishes to plugins-dist for jsDelivr delivery; an environment variable may override it for self-hosting.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";
