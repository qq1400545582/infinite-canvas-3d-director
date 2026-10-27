import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 主体库（Subject Library）
 *
 * 用途：在创作任务开始前选定「主体」，并在后续整个任务中保持一致。
 * - 个人主体：用户自己上传（图片压缩后以 dataURL 存在 localStorage，避免污染资产 IndexedDB）。
 * - 公共主体：系统内置的静态目录，不可编辑、不可删除。
 *
 * 独立存储的原因：资产库的 Asset 模型只有 text/image/video 三种 kind，
 * 直接加第四种会波及资产页以外的所有消费方；主体库自成一套数据，两边互不影响。
 */

export type SubjectType = "personal" | "public";

export type Subject = {
    id: string;
    name: string;
    type: SubjectType;
    /** 主体形象：个人主体为用户上传的 dataURL；公共主体为空时用首字头像 */
    image?: string;
    /** 一致性描述：身份 / 外观 / 服装，发送时随提示词一起带出，保证前后一致 */
    note: string;
    createdAt: number;
};

/** 内置公共主体：本地没有形象素材，用首字头像呈现，描述保证跨任务一致。 */
export const PUBLIC_SUBJECTS: Subject[] = [
    { id: "public-linchuan", name: "林川", type: "public", note: "27 岁男性，短黑发，深灰色长风衣，轮廓硬朗，眼神克制", createdAt: 0 },
    { id: "public-suwan", name: "苏晚", type: "public", note: "25 岁女性，黑色长直发，米白色针织衫，气质清冷，妆容干净", createdAt: 0 },
    { id: "public-ache", name: "阿澈", type: "public", note: "16 岁少年，蓬松短发，深蓝校服外套，眼神明亮，身形清瘦", createdAt: 0 },
    { id: "public-qinghe", name: "清和", type: "public", note: "18 岁少女，及肩黑发，浅蓝连衣裙，神态安静，皮肤白皙", createdAt: 0 },
    { id: "public-chenbo", name: "陈伯", type: "public", note: "60 岁男性，花白短发，藏青色夹克，面容温和，背略驼", createdAt: 0 },
    { id: "public-moya", name: "墨鸦", type: "public", note: "30 岁男性，黑色长发束起，深色立领唐装，气质阴郁，左眉有疤", createdAt: 0 },
    { id: "public-tuanzi", name: "团子", type: "public", note: "白色短毛猫，圆脸，琥珀色眼睛，尾巴蓬松，体态圆润", createdAt: 0 },
    { id: "public-narrator", name: "叙述者", type: "public", note: "无固定形象，仅以画外旁白出现，声音低沉平稳", createdAt: 0 },
];

type SubjectStore = {
    personal: Subject[];
    /** 当前任务使用的主体（持久化，保证跨任务、跨页面一致） */
    selectedId: string | null;
    addPersonal: (input: { name: string; note: string; image: string }) => Subject;
    removePersonal: (id: string) => void;
    select: (id: string | null) => void;
};

function newId() {
    return `personal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const useSubjectStore = create<SubjectStore>()(
    persist(
        (set) => ({
            personal: [],
            selectedId: null,
            addPersonal: ({ name, note, image }) => {
                const subject: Subject = { id: newId(), name: name.trim(), type: "personal", image, note: note.trim(), createdAt: Date.now() };
                set((state) => ({ personal: [subject, ...state.personal], selectedId: subject.id }));
                return subject;
            },
            removePersonal: (id) =>
                set((state) => ({
                    personal: state.personal.filter((item) => item.id !== id),
                    selectedId: state.selectedId === id ? null : state.selectedId,
                })),
            select: (id) => set({ selectedId: id }),
        }),
        { name: "infinite-canvas:subject_store" },
    ),
);

/** 公共主体 + 个人主体合并查找（用于把 selectedId 还原成对象）。 */
export function findSubject(id: string | null): Subject | null {
    if (!id) return null;
    const personal = useSubjectStore.getState().personal;
    return personal.find((item) => item.id === id) ?? PUBLIC_SUBJECTS.find((item) => item.id === id) ?? null;
}
