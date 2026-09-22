import { useMemo } from "react";

import { connectors } from "./data/connectors";
import { experts } from "./data/experts";
import { skills } from "./data/skills";
import { INSTALLED_CATEGORY, MY_CONNECTORS_CATEGORY, MY_EXPERTS_CATEGORY, type LibraryItem, type LibraryKind } from "./data/types";
import { connectorToLibraryItem, installToLibraryItem, useUserLibrary } from "./state/user-library";

export const ALL_OPTION = "__all__";

export { INSTALLED_CATEGORY, MY_CONNECTORS_CATEGORY, MY_EXPERTS_CATEGORY };

/**
 * 按类型汇总专家库条目：内置目录 + 用户创建的「我的专家」+ 本地已安装技能 + 自定义连接器。
 * 已安装技能若同名存在于目录中则不重复展示（以目录条目为准）。
 */
export function useLibraryItems(kind: LibraryKind): LibraryItem[] {
    const userExperts = useUserLibrary((state) => state.experts);
    const installs = useUserLibrary((state) => state.installs);
    const userConnectors = useUserLibrary((state) => state.connectors);
    return useMemo(() => {
        if (kind === "expert") return [...userExperts, ...experts];
        if (kind === "skill") {
            const catalog = new Set(skills.flatMap((skill) => [skill.id.toLowerCase(), skill.name.toLowerCase()]));
            const installed = installs.filter((record) => !catalog.has(record.name.toLowerCase())).map(installToLibraryItem);
            return [...installed, ...skills];
        }
        // 自定义连接器置顶，方便用户第一时间看到自己配置的服务
        return [...userConnectors.map(connectorToLibraryItem), ...connectors];
    }, [kind, userExperts, installs, userConnectors]);
}

/** 按分类聚合出侧边栏选项，并按关键词（名称/简介/标签）与分类联合过滤。 */
export function useLibraryFilter(items: LibraryItem[], keyword: string, category: string) {
    const categories = useMemo(() => Array.from(new Set(items.map((item) => item.category))), [items]);
    const filtered = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        return items.filter((item) => {
            if (category !== ALL_OPTION && item.category !== category) return false;
            if (!kw) return true;
            return [item.name, item.description, ...item.tags].join(" ").toLowerCase().includes(kw);
        });
    }, [items, keyword, category]);
    return { total: items.length, categories, filtered };
}

/** 仅按关键词过滤（「我的专家」视图使用）。 */
export function filterByKeyword(items: LibraryItem[], keyword: string) {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return items;
    return items.filter((item) => [item.name, item.description, ...item.tags].join(" ").toLowerCase().includes(kw));
}
