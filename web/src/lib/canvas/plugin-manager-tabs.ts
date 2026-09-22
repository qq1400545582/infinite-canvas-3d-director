import type { ReactNode } from "react";

/**
 * 节点插件管理器的「扩展标签页」注册表。
 *
 * 目的：让功能模块（如专家库）在不改动插件管理器自身逻辑的前提下，把自己的
 * 内容作为额外标签页挂进「节点插件」弹窗 —— 与画布节点定义使用同一套「注册表」
 * 思路，宿主只负责按注册顺序渲染。
 *
 * 约定：
 * - 各模块在**模块加载时**调用 `registerPluginManagerTab`（注册表是模块级数组）；
 * - `key` 唯一，重复注册同 key 视为覆盖（便于热更新 / 页面重挂载时自愈）；
 * - 注册表为空时，插件管理器保持原有三个标签页，行为与未引入本扩展点完全一致。
 */
export interface PluginManagerTab {
    /** 唯一 key，同时作为 Tabs 的 key */
    key: string;
    /** 标签页标题（ReactNode：调用方可传入自带 i18n 的组件，以便切换语言时同步刷新） */
    label: ReactNode;
    /** 标签页内容 */
    children: ReactNode;
}

const tabs: PluginManagerTab[] = [];

export function registerPluginManagerTab(tab: PluginManagerTab) {
    const index = tabs.findIndex((item) => item.key === tab.key);
    if (index >= 0) tabs[index] = tab;
    else tabs.push(tab);
}

/** 按注册顺序返回扩展标签页（返回内部数组的只读视图副本）。 */
export function getPluginManagerTabs(): PluginManagerTab[] {
    return tabs;
}
