import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasPlugin } from "@/types/canvas-plugin";
import i18n from "@/i18n";

const cleanups = new Map<string, () => void>();

// A remote plugin may export CanvasPlugin directly or a factory that receives runtime and returns CanvasPlugin.
// The factory uses runtime.React so the bundle does not need its own React copy.
async function evaluatePluginSource(source: string): Promise<CanvasPlugin> {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown; plugin?: unknown };
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as (runtime: unknown) => unknown)(getPluginRuntime()) : exported;
        assertPlugin(plugin);
        return plugin;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): asserts plugin is CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error(i18n.t("canvas.pluginErrors.invalidExport"));
    if (!value.id || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error(i18n.t("canvas.pluginErrors.missingFields"));
}

export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // Inject declared styles when enabled and remove them when disabled or uninstalled.
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

async function fetchPluginSource(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("canvas.pluginErrors.downloadFailed", { status: response.status }));
    return response.text();
}

// Add a cache-busting parameter so watch builds load the latest output.
function withCacheBust(url: string) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

// Install or replace a plugin from a URL and enable it immediately.
// bustCache bypasses HTTP/CDN caches during upgrades while persisting a clean URL without the timestamp query.
export async function installPluginFromUrl(url: string, opts?: { official?: boolean; bustCache?: boolean }) {
    const source = await fetchPluginSource(opts?.bustCache ? withCacheBust(url) : url);
    const plugin = await evaluatePluginSource(source);
    deactivatePlugin(plugin.id); // Replace the previous version.
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url, source, enabled: true, official: opts?.official });
    activatePlugin(plugin);
    return plugin;
}

export async function updatePlugin(record: InstalledPlugin) {
    // Upgrades must fetch the latest output and therefore always bypass caches.
    return installPluginFromUrl(record.url, { official: record.official, bustCache: true });
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    if (!enabled) {
        deactivatePlugin(record.id);
        usePluginStore.getState().setEnabled(record.id, false);
        return;
    }
    try {
        // Commit the switch only after the node definitions are actually available.
        const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
        const plugin = await evaluatePluginSource(source);
        deactivatePlugin(record.id);
        activatePlugin(plugin);
        usePluginStore.getState().setEnabled(record.id, true);
    } catch (error) {
        deactivatePlugin(record.id);
        usePluginStore.getState().setEnabled(record.id, false);
        throw error; // The manager displays the error; the switch remains available for retry.
    }
}

export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
}

let loading: Promise<void> | null = null;

// Concurrent canvas mounts share initialization instead of returning before registration.
export function ensurePluginsLoaded(): Promise<void> {
    if (!loading) {
        loading = loadInstalledPlugins().catch((error) => {
            loading = null;
            throw error;
        });
    }
    return loading;
}

async function loadInstalledPlugins() {
    await usePluginStore.persist.rehydrate();
    const discovered = await loadLocalPlugins();
    const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
    await Promise.all(
        records.map(async (record) => {
            try {
                // Reuse this startup's validated local module: do not download it twice.
                const plugin = discovered.get(record.id) ?? await evaluatePluginSource(
                    record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source,
                );
                // Respect a toggle/uninstall that occurred while loading.
                if (!usePluginStore.getState().plugins.some((item) => item.id === record.id && item.enabled)) return;
                activatePlugin(plugin);
            } catch (error) {
                deactivatePlugin(record.id);
                usePluginStore.getState().setEnabled(record.id, false);
                console.error(`[plugin] Failed to load: ${record.id}`, error);
            }
        }),
    );
    await loadDevPlugins();
}

// Self-developed local plugins enabled automatically on first discovery so the canvas works
// out of the box on web/desktop builds. Existing user toggles are always preserved via `existing?.enabled`.
const PRESET_ENABLED_LOCAL_PLUGINS = new Set<string>([
    "clipshot-run",
    "director-desk",
    "jlmlh-3d-director",
    "openreel-video",
]);

// Discover local plugins from web/public/plugins, add them disabled, and expose them in the manager without a URL.
// Refresh metadata and source for existing records while preserving the enabled flag so persisted versions stay current.
async function loadLocalPlugins() {
    const discovered = new Map<string, CanvasPlugin>();
    let urls: unknown;
    try {
        const response = await fetch("/plugins/index.json");
        if (!response.ok) return discovered;
        urls = await response.json();
    } catch {
        return discovered; // No local manifest, such as production builds without plugins.
    }
    if (!Array.isArray(urls) || !urls.length) return discovered;
    await Promise.all(
        urls.map(async (url: string) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                const store = usePluginStore.getState();
                const existing = store.plugins.find((item) => item.id === plugin.id);
                discovered.set(plugin.id, plugin);
                store.upsert({
                    id: plugin.id,
                    name: plugin.name || plugin.id,
                    version: plugin.version || "0.0.0",
                    description: plugin.description,
                    url,
                    source,
                    enabled: existing?.enabled ?? PRESET_ENABLED_LOCAL_PLUGINS.has(plugin.id), // Preserve the user setting; preset self-developed plugins enable on first discovery.
                    local: true,
                });
            } catch (error) {
                console.error(`[plugin] Failed to discover local plugin: ${url}`, error);
            }
        }),
    );
    return discovered;
}

// During local development, refetch VITE_DEV_PLUGINS URLs without caching or persistence on every startup.
// Together with watch builds, refreshing the page loads code changes without reinstalling the plugin.
async function loadDevPlugins() {
    const raw = import.meta.env.VITE_DEV_PLUGINS;
    if (!raw) return;
    const urls = raw.split(",").map((item) => item.trim()).filter(Boolean);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                deactivatePlugin(plugin.id);
                activatePlugin(plugin);
                console.info(`[plugin] Dev plugin loaded: ${plugin.id} (${url})`);
            } catch (error) {
                console.error(`[plugin] Failed to load dev plugin: ${url}`, error);
            }
        }),
    );
}
