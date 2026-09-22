import type { Middleware } from "./server";
// 直接复用 web/ 的画布内「一键启动后端」中间件，零重写（P2）。
// 该中间件仅 import node:* 与 `import type` 的 vite 类型，运行时无外部依赖，
// 经 electron-vite 打进 main bundle 即可在桌面壳本机服务上逐字节一致地工作。
import { canvasAgentLauncher } from "../../web/vite-plugins/canvas-agent-launcher";

/**
 * 用「假 server」把 Vite 插件的 connect 中间件捞出来，挂进本机 HTTP 服务。
 * 这样 dev server 与桌面壳的行为完全一致，且 web/ 不需要任何改造。
 */
export function createAgentMiddleware(): Middleware[] {
    const handlers: Middleware[] = [];
    const fakeServer = {
        middlewares: {
            use: (fn: Middleware) => handlers.push(fn),
        },
    };
    // 类型上 configureServer 需要 Vite 的 Server 类型，这里用结构化兼容对象即可（只用 middlewares.use）。
    canvasAgentLauncher().configureServer(fakeServer as unknown as Parameters<ReturnType<typeof canvasAgentLauncher>["configureServer"]>[0]);
    return handlers;
}
