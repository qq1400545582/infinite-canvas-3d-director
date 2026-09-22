import type { ReactNode } from "react";

/**
 * 智能体输入框 `/` 命令的「可调用项」来源注册表。
 *
 * 输入框原本只把 `/` 用于本机 Agent 的 Skill 列表。为了让「专家 / 技能 / 连接器」
 * 也能在任务里用 `/` 直接调用，这里提供一个极简的扩展点：功能模块注册一个
 * `search` 函数，输入框在用户输入 `/` 时调用它，把命中的条目并入候选列表。
 *
 * 约定：
 * - `search` 必须是**纯读取**的（不得触发副作用），输入框每次按键都会调用；
 * - 返回项按顺序拼接，输入框只取前若干条，超出部分自行截断；
 * - 任一来源抛错都不影响其它来源与输入框原有行为。
 */
export interface ComposerCallableItem {
    /** 稳定唯一 id（建议 `kind:id`） */
    id: string;
    /** 展示标题 */
    label: string;
    /** 副标题 / 简介 */
    description: string;
    /** 类型标签（如「专家」「技能」「连接器」） */
    kindLabel: string;
    /** 图标（可选） */
    icon?: ReactNode;
    /** 命中后执行的调用动作 */
    run: () => void | Promise<void>;
}

export interface ComposerCallableSource {
    id: string;
    search: (query: string) => ComposerCallableItem[];
}

const sources: ComposerCallableSource[] = [];

export function registerComposerCallableSource(source: ComposerCallableSource) {
    const index = sources.findIndex((item) => item.id === source.id);
    if (index >= 0) sources[index] = source;
    else sources.push(source);
}

/** 按注册顺序汇总各来源的命中项。 */
export function searchComposerCallables(query: string, limit = 8): ComposerCallableItem[] {
    const keyword = query.trim().toLowerCase();
    const out: ComposerCallableItem[] = [];
    for (const source of sources) {
        try {
            for (const item of source.search(keyword)) {
                if (out.length >= limit) return out;
                out.push(item);
            }
        } catch {
            /* 单个来源失败不影响其它来源 */
        }
    }
    return out;
}
