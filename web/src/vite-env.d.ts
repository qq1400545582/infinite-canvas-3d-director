/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_RELEASES__: import("@/lib/release").ReleaseInfo[];

interface ImportMetaEnv {
    // Comma-separated local development plugin URLs, refetched on every startup without caching or persistence.
    readonly VITE_DEV_PLUGINS?: string;
    // Optional build-time analytics configuration, with one independent variable per provider.
    // GA4 measurement ID (G-XXXX)
    readonly VITE_ANALYTICS_GA4_ID?: string;
    // Baidu Analytics site ID
    readonly VITE_ANALYTICS_BAIDU_ID?: string;
    // Desktop installer download link (absolute URL or site-relative path). When unset, the latest
    // GitHub Release asset is resolved at runtime — see constant/desktop-download.ts.
    readonly VITE_DESKTOP_DOWNLOAD_URL?: string;
    // Repository (owner/repo) holding desktop releases; defaults to the desktop build.publish target.
    readonly VITE_DESKTOP_RELEASES_REPO?: string;
}
