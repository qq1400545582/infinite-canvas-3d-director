// 分镜工作台 / 分镜出图 共用工具（clipshot）
// -----------------------------------------------------------------------------
// 仅放与上游规范无关的实现细节：JSON 容错解析、极简 Markdown 表格、主题样式工厂，
// 以及「把生成结果落成画布图片节点」所需的媒体持久化（复用宿主媒体库）。

import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";

export type Theme = CanvasNodeContentProps["ctx"]["theme"];

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function asText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

/** 从模型输出里稳健地取出 JSON 对象（容忍 ```json 围栏与前后杂字）。 */
export function extractJson(raw: string): Record<string, unknown> | null {
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 极简 Markdown 表格渲染（只处理 | 表格，够用即可，不引入依赖）
// ---------------------------------------------------------------------------

function stripInline(text: string) {
    return text.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function splitRow(line: string) {
    return line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((cell) => stripInline(cell));
}

function isSeparatorRow(line: string) {
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

export function parseMarkdownTables(markdown: string): { headers: string[]; rows: string[][] }[] {
    const lines = markdown.split("\n");
    const tables: { headers: string[]; rows: string[][] }[] = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].trim().startsWith("|")) {
            i += 1;
            continue;
        }
        const block: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
            block.push(lines[i]);
            i += 1;
        }
        if (block.length < 2) continue;
        const headers = splitRow(block[0]);
        const rows = block.slice(1).filter((line) => !isSeparatorRow(line)).map(splitRow);
        if (headers.length) tables.push({ headers, rows });
    }
    return tables;
}

export function MarkdownTables({ theme, markdown }: { theme: Theme; markdown: string }) {
    const tables = parseMarkdownTables(markdown);
    if (!tables.length) {
        return markdown.trim() ? <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{markdown}</div> : null;
    }
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {tables.map((table, ti) => (
                <div key={ti} style={{ overflowX: "auto", border: `1px solid ${theme.node.stroke}`, borderRadius: 8 }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 11.5, minWidth: "100%" }}>
                        <thead>
                            <tr>
                                {table.headers.map((head, hi) => (
                                    <th
                                        key={hi}
                                        style={{
                                            textAlign: "left",
                                            padding: "6px 8px",
                                            whiteSpace: "nowrap",
                                            background: theme.node.faint,
                                            borderBottom: `1px solid ${theme.node.stroke}`,
                                            color: theme.node.text,
                                            fontWeight: 600,
                                        }}
                                    >
                                        {head}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {table.rows.map((row, ri) => (
                                <tr key={ri}>
                                    {table.headers.map((_, ci) => (
                                        <td
                                            key={ci}
                                            style={{
                                                padding: "6px 8px",
                                                verticalAlign: "top",
                                                borderTop: `1px solid ${theme.node.stroke}`,
                                                color: theme.node.text,
                                                minWidth: 96,
                                            }}
                                        >
                                            {row[ci] ?? ""}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// 主题样式工厂（两个节点共用同一套观感）
// ---------------------------------------------------------------------------

export const ACCENT = "#8b5cf6";

export function accentStyles(theme: Theme) {
    return {
        labelStyle: { fontSize: 11, color: theme.node.muted, marginBottom: 4, display: "block" } as const,
        fieldStyle: {
            width: "100%",
            boxSizing: "border-box" as const,
            background: theme.node.faint,
            color: theme.node.text,
            border: `1px solid ${theme.node.stroke}`,
            borderRadius: 8,
            padding: "7px 9px",
            fontSize: 12,
            outline: "none",
            fontFamily: "inherit",
        },
        /** 小号胶囊按钮（预设、次级操作） */
        chipStyle: (active?: boolean) => ({
            cursor: "pointer",
            padding: "3px 9px",
            borderRadius: 999,
            fontSize: 11,
            border: `1px solid ${active ? ACCENT : theme.node.stroke}`,
            background: active ? "rgba(139,92,246,.16)" : "transparent",
            color: theme.node.text,
            lineHeight: 1.6,
        }),
        buttonStyle: (primary?: boolean, disabled?: boolean) => ({
            cursor: disabled ? "not-allowed" : "pointer",
            padding: "6px 12px",
            borderRadius: 8,
            fontSize: 12,
            border: `1px solid ${primary ? ACCENT : theme.node.stroke}`,
            background: primary ? (disabled ? theme.node.faint : ACCENT) : "transparent",
            color: primary ? (disabled ? theme.node.muted : "#fff") : theme.node.text,
            opacity: disabled ? 0.6 : 1,
        }),
    };
}

export function titleBarStyle(theme: Theme) {
    return {
        flex: "0 0 auto" as const,
        height: 34,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        background: theme.node.faint,
        borderBottom: `1px solid ${theme.node.stroke}`,
        fontSize: 12,
    };
}

export function bodyStyle() {
    return {
        flex: "1 1 auto",
        minHeight: 0,
        overflowY: "auto" as const,
        padding: 12,
        display: "flex",
        flexDirection: "column" as const,
        gap: 10,
    };
}

export function statusTextStyle() {
    return {
        flex: "1 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap" as const,
        color: ACCENT,
    };
}

// ---------------------------------------------------------------------------
// 媒体持久化：把生成结果写进宿主媒体库
//
// 宿主用 localforage 管理图片：createInstance({ name: "infinite-canvas", storeName: "image_files" })，
// 其 IndexedDB 驱动对 Blob 是直接 store.put(blob, key)（见 localforage 的 setItem 实现），
// 键形如 "image:<id>"，节点 metadata.storageKey 就是这个键。
// 这里按同一约定直接写入，使图片节点刷新后仍可解析（hydrateCanvasImages → resolveImageUrl），
// 且 collectImageStorageKeys 会把它算作「在用」，不会被 cleanupUnusedImages 清掉。
// ---------------------------------------------------------------------------

const IMAGE_DB_NAME = "infinite-canvas";
const IMAGE_STORE_NAME = "image_files";

/** 打开宿主媒体库；若存储尚未建立（拿不到 image_files），返回 null 由调用方回退。 */
function openHostImageDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === "undefined") {
            resolve(null);
            return;
        }
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(IMAGE_DB_NAME);
        } catch {
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            // 库不存在时浏览器会新建空库：这里中止升级事务（不创建任何 store），随后放弃持久化，
            // 避免干扰宿主自己的存储初始化。
            try {
                request.transaction?.abort();
            } catch {
                // 忽略：onerror 会兜底
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
                db.close();
                resolve(null);
                return;
            }
            resolve(db);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!match) return null;
    const mime = match[1] || "image/png";
    const body = match[3] || "";
    try {
        if (match[2]) {
            const binary = atob(body);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(body)], { type: mime });
    } catch {
        return null;
    }
}

export function mediaId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 写入并回读校验；只有回读到的 Blob 与写入一致才算成功。 */
export async function persistImageBlob(storageKey: string, blob: Blob) {
    const db = await openHostImageDb();
    if (!db) return false;
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(IMAGE_STORE_NAME, "readwrite");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
            try {
                tx.objectStore(IMAGE_STORE_NAME).put(blob, storageKey);
            } catch (error) {
                reject(error);
            }
        });
        const stored = await new Promise<Blob | null>((resolve) => {
            const tx = db.transaction(IMAGE_STORE_NAME, "readonly");
            const req = tx.objectStore(IMAGE_STORE_NAME).get(storageKey);
            req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
            req.onerror = () => resolve(null);
        });
        return Boolean(stored && stored.size === blob.size);
    } catch {
        return false;
    } finally {
        db.close();
    }
}

export function loadImageSize(url: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

/** 按图片实际比例把节点尺寸装进一个方框，避免拉伸。 */
export function fitNodeSize(width: number, height: number, box: number, maxHeight = box) {
    if (!width || !height) return { width: box, height: Math.round(box * 0.625) };
    const scale = Math.min(box / width, maxHeight / height);
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export type PersistedPanelImage = {
    url: string;
    storageKey?: string;
    mimeType: string;
    bytes: number;
    width: number;
    height: number;
    persisted: boolean;
};

/**
 * 把模型返回的 dataURL 落成可长期使用的图片资源：
 * 优先写入宿主媒体库（拿到真 storageKey），失败则回退 dataURL（刷新后由宿主自行上传）。
 */
export async function preparePanelImage(dataUrl: string): Promise<PersistedPanelImage> {
    const blob = dataUrlToBlob(dataUrl);
    const objectUrl = blob ? URL.createObjectURL(blob) : dataUrl;
    const size = await loadImageSize(objectUrl);
    if (!blob) {
        return { url: dataUrl, mimeType: "image/png", bytes: 0, width: size?.width || 0, height: size?.height || 0, persisted: false };
    }
    const storageKey = `image:${mediaId()}`;
    const persisted = await persistImageBlob(storageKey, blob);
    return {
        url: persisted ? objectUrl : dataUrl,
        ...(persisted ? { storageKey } : {}),
        mimeType: blob.type || "image/png",
        bytes: blob.size,
        width: size?.width || 0,
        height: size?.height || 0,
        persisted,
    };
}
