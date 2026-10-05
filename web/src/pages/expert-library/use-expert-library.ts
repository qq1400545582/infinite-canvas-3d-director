import { useMemo } from "react";

import { connectors } from "./data/connectors";
import { experts } from "./data/experts";
import { SELF_MEDIA_CATEGORY, selfMediaSkills } from "./data/self-media";
import { skills } from "./data/skills";
import { INSTALLED_CATEGORY, MY_CONNECTORS_CATEGORY, MY_EXPERTS_CATEGORY, type LibraryItem, type LibraryKind } from "./data/types";
import { connectorToLibraryItem, installToLibraryItem, normalizeChannelItem, useUserLibrary } from "./state/user-library";

export const ALL_OPTION = "__all__";

export { INSTALLED_CATEGORY, MY_CONNECTORS_CATEGORY, MY_EXPERTS_CATEGORY, SELF_MEDIA_CATEGORY };

/**
 * 覆盖层条目补齐卡片展示字段（职称 / 头像 / 徽标 / 出品方 / 团队标记）。
 *
 * 覆盖层持久化在 localStorage：早期拉取存下的条目没有这些字段，若直接使用会退化成
 * 「无头像 + 名称为标题」的旧样式。这里以静态目录为准回填缺失字段，使存量数据同样按
 * WorkBuddy 卡片形态渲染；覆盖层自带的字段始终优先。
 */
function fillCardFields(items: LibraryItem[]): LibraryItem[] {
    const staticById = new Map(experts.map((item) => [item.id, item]));
    return items.map((item) => {
        const base = staticById.get(item.id);
        if (!base) return item;
        return {
            ...item,
            profession: item.profession ?? base.profession,
            avatar: item.avatar ?? base.avatar,
            badge: item.badge ?? base.badge,
            author: item.author ?? base.author,
            team: item.team ?? base.team,
        };
    });
}

/**
 * 按类型汇总专家库条目：内置目录 + 用户创建的「我的专家」+ 本地已安装技能 + 自定义连接器。
 * 已安装技能若同名存在于目录中则不重复展示（以目录条目为准）。
 *
 * 「立即拉取 WorkBuddy 更新」的覆盖层（catalogOverlay）与静态目录按 id 合并：
 * 覆盖层条目优先（同 id 替换静态旧条目，新 id 追加在静态目录之前）。
 */
export function useLibraryItems(kind: LibraryKind): LibraryItem[] {
    const userExperts = useUserLibrary((state) => state.experts);
    const installs = useUserLibrary((state) => state.installs);
    const userConnectors = useUserLibrary((state) => state.connectors);
    const catalogOverlay = useUserLibrary((state) => state.catalog);
    const removed = useUserLibrary((state) => state.removed);
    const channelItems = useUserLibrary((state) => state.channelItems);
    return useMemo(() => {
        if (kind === "expert") {
            const hidden = new Set(removed.experts);
            const overlayIds = new Set(catalogOverlay.experts.map((item) => item.id));
            return [...userExperts, ...fillCardFields(catalogOverlay.experts), ...experts.filter((item) => !overlayIds.has(item.id))].filter((item) => !hidden.has(item.id));
        }
        if (kind === "skill") {
            const hidden = new Set(removed.skills);
            // 自媒体（LibTV）技能并入，但**分类名统一为 SELF_MEDIA_CATEGORY**（不沿用它自己的
            // 专业影视 / 短剧漫剧…那 7 个分类）——否则侧栏会平铺出 7 个新分类，把「视频创作 /
            // 办公 / 开发工具」这些常用分类挤到下面。细分维度改由 tags 承载。
            // 产出形态在 meta.产出形态，卡片标签已含形态，筛选与展示都够用。
            const channelSkills = Object.entries(channelItems)
                .flatMap(([, list]) => list)
                .map((item) => ({ ...normalizeChannelItem(item), category: SELF_MEDIA_CATEGORY }));
            const selfMedia = [...selfMediaSkills, ...channelSkills].map((item) => ({ ...item, category: SELF_MEDIA_CATEGORY }));
            // 本机技能目录的 key 用于判断「是否已在静态目录里」，避免与自媒体重复
            const localKeys = new Set(skills.flatMap((skill) => [skill.id.toLowerCase(), skill.name.toLowerCase()]));
            const installed = installs
                .filter((record) => !localKeys.has(record.name.toLowerCase()))
                .filter((record) => !hidden.has(record.name))
                .map(installToLibraryItem);
            const byId = new Map<string, LibraryItem>();
            for (const item of channelSkills) if (!hidden.has(item.id)) byId.set(item.id, item);
            for (const item of selfMediaSkills) if (!hidden.has(item.id)) byId.set(item.id, { ...item, category: SELF_MEDIA_CATEGORY });
            for (const item of skills) if (!hidden.has(item.id)) byId.set(item.id, item);
            return [...installed, ...byId.values()];
        }
        // 自定义连接器置顶，方便用户第一时间看到自己配置的服务
        const hidden = new Set(removed.connectors);
        const overlayIds = new Set(catalogOverlay.connectors.map((item) => item.id));
        return [...userConnectors.map(connectorToLibraryItem), ...catalogOverlay.connectors, ...connectors.filter((item) => !overlayIds.has(item.id))].filter((item) => !hidden.has(item.id));
    }, [kind, userExperts, installs, userConnectors, catalogOverlay, removed, channelItems]);
}

/** 按分类聚合出侧边栏选项，并按关键词（名称/简介/标签）与分类联合过滤。 */
export function useLibraryFilter(items: LibraryItem[], keyword: string, category: string) {
    const categories = useMemo(() => {
        const counts = new Map<string, number>();
        for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
        const list = [...counts.entries()].map(([name, count]) => ({ name, count }));
        // 「自媒体」置顶：它有 1300+ 条，是用户进这个页面的主要目的之一；
        // 其余分类按条数降序（原来的 Set 去重顺序不稳定，会让侧栏看起来随机跳动）。
        const SELF = SELF_MEDIA_CATEGORY;
        return list.sort((a, b) => (a.name === SELF ? -1 : b.name === SELF ? 1 : b.count - a.count));
    }, [items]);
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
