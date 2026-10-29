import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { LicenseGate } from "@/features/license/license-gate";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import AuthPage from "@/pages/auth";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import ExpertLibraryPage from "@/pages/expert-library";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import PurchasePage from "@/pages/purchase";
import SendPage from "@/pages/send";
import VideoPage from "@/pages/video";

export const router = createBrowserRouter([
    {
        element: (
            <LicenseGate>
                <UserLayout>
                    <AnalyticsTracker />
                    <Outlet />
                </UserLayout>
            </LicenseGate>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
            { path: "/experts", element: <ExpertLibraryPage /> },
        ],
    },
    // 登录 / 购买刻意放在 Licensed 布局之外：
    // 未登录或试用到期时也要能进入，且不渲染主导航，避免与守卫互相跳转形成死循环。
    // 运营后台不在本应用内（由授权服务自己提供：https://<授权服务域名>/admin）。
    { path: "/login", element: <AuthPage /> },
    { path: "/purchase", element: <PurchasePage /> },
    // 发送台刻意放在 UserLayout 之外：任何能打开 http://127.0.0.1:3000/send 的浏览器 /
    // 桌面工具内置浏览器都能直接用，不依赖站点导航与登录态。
    { path: "/send", element: <SendPage /> },
    { path: "*", element: <NotFound /> },
]);
