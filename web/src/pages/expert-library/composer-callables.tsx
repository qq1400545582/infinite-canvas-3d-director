import { registerComposerCallableSource, type ComposerCallableItem } from "@/lib/agent/composer-callables";
import { resolveIcon } from "./components/icon-map";
import { KIND_LABELS, type LibraryItem } from "./data/types";
import { invokeItem } from "./invoke-mode";
import { libraryItems } from "./library-nodes";

/**
 * 让「专家 / 技能 / 连接器」在任务（智能体输入框）里可以用 `/` 直接调用。
 *
 * 通过 `@/lib/agent/composer-callables` 的扩展点注册一个只读搜索源：
 * 用户输入 `/` 时，输入框会调用这里的 `search`，把命中的专家库条目并入候选，
 * 选中后走与专家库页面**同一个** `invokeInCanvas`（预填调用提示 + 展开面板），
 * 因此不存在第二套调用逻辑。
 */

const KIND_ORDER: Record<LibraryItem["kind"], number> = { expert: 0, skill: 1, connector: 2 };

/** 排序权重：完全匹配 > 前缀匹配 > 包含匹配 > 其它。 */
function rankByName(item: LibraryItem, keyword: string) {
    if (!keyword) return 10;
    const name = item.name.toLowerCase();
    if (name === keyword) return 0;
    if (name.startsWith(keyword)) return 1;
    if (name.includes(keyword)) return 2;
    return 3;
}

function searchLibraryCallables(keyword: string): ComposerCallableItem[] {
    const matched = libraryItems().filter((item) => {
        if (!keyword) return true;
        return [item.name, item.description, item.category, KIND_LABELS[item.kind], ...item.tags]
            .join(" ")
            .toLowerCase()
            .includes(keyword);
    });
    return matched
        .sort((a, b) => rankByName(a, keyword) - rankByName(b, keyword) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((item) => {
            const Icon = resolveIcon(item.icon);
            return {
                id: `${item.kind}:${item.id}`,
                label: item.name,
                description: item.description,
                kindLabel: KIND_LABELS[item.kind],
                icon: <Icon className="size-4" />,
                run: () => {
                    void invokeItem(item);
                },
            };
        });
}

registerComposerCallableSource({ id: "expert-library", search: searchLibraryCallables });
