import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 主体库（Subject Library）
 *
 * - 个人主体：用户上传 / 编辑，形象图压缩成 256px 的 dataURL 存 localStorage。
 * - 公共主体：系统内置（形象图 + 三视图从公共主体列表截图裁切而来，放在 web/public/subjects/）。
 *
 * 两种主体共用一套字段，因此列表、详情、选择逻辑只有一份实现。
 * 独立于资产库：资产页的 Asset 模型只认 text/image/video，主体库自成一套数据，互不影响。
 */

export type SubjectType = "personal" | "public";
export type SubjectCategory = "character" | "scene";
/** 可见性：仅自己 / 公开到公共主体库（公开后出现在「公共主体」分类，其他使用者可选） */
export type SubjectVisibility = "private" | "public";

export type Subject = {
    id: string;
    name: string;
    type: SubjectType;
    category: SubjectCategory;
    /** 上传主体时指定：private 只在「个人添加」里，public 同时出现在「公共主体」 */
    visibility: SubjectVisibility;
    /** 列表卡片形象图（公共主体自带三视图叠加，与参考站一致） */
    image?: string;
    /** 详情页大图（无三视图叠加） */
    hero?: string;
    /** 三视图（正面 / 侧面 / 背面） */
    turn?: string;
    /** 一致性描述：身份 / 外观 / 服装，随任务带出 */
    note: string;
    tags: string[];
    /** 音色（仅记录文件名，不参与生成） */
    voice?: string;
    starred?: boolean;
    createdAt: number;
};

const img = (id: string) => `/subjects/${id}.jpg`;
const heroImg = (id: string) => `/subjects/${id}-hero.jpg`;
const turnImg = (id: string) => `/subjects/${id}-turn.jpg`;

function pub(id: string, name: string, note: string, tags: string[]): Subject {
    return {
        id: `public-${id}`,
        name,
        type: "public",
        category: "character",
        visibility: "public",
        image: img(id),
        hero: heroImg(id),
        turn: turnImg(id),
        note,
        tags,
        createdAt: 0,
    };
}

/** 内置公共主体（顺序即截图里的排列）。 */
export const PUBLIC_SUBJECTS: Subject[] = [
    pub(
        "blonde-lady",
        "金发女郎",
        "年轻女性，白人，复古波浪短卷发，浅金色，面带微笑，五官柔和立体，绿色眼睛，穿浅米色底色配粉色小碎花短袖泡泡袖衬衫，高腰鹅黄色百褶长裙",
        ["复古", "女性", "写实"],
    ),
    pub("classic-gentleman", "古典绅士", "中年男性，深棕色背头，轮廓分明，穿米色西装三件套配深色领带，外搭深灰大衣，气质沉稳", ["复古", "男性", "正装"]),
    pub("cowboy", "沉着牛仔", "成年男性，棕色宽檐帽，蓄短须，穿白色衬衫配背带，深色长裤，神态放松", ["西部", "男性"]),
    pub("singer", "魅力歌手", "成年男性，深色卷发，穿白色西装外套内搭印花衬衫，笑容自信，舞台气质", ["男性", "舞台"]),
    pub("punk-youth", "朋克青年", "青年男性，黑色长卷发，戴墨镜，穿深灰做旧夹克，内搭印花 T 恤，气质反叛", ["潮流", "男性"]),
    pub("retro-girl", "复古少女", "年轻女性，金色短卷发，戴头戴式耳机，穿棕色短夹克配格纹围巾", ["复古", "女性"]),
    pub("young-clerk", "年轻职员", "青年男性，金色短发，穿黑色西装配白衬衫黑领带，站姿端正", ["职场", "男性"]),
    pub("blonde-clerk", "金发职员", "年轻女性，金色盘发，戴细框眼镜，抱白色文件夹，穿黑色西装套裙", ["职场", "女性"]),
    pub("executive", "高级主管", "中年男性，灰白短发，戴黑框眼镜，穿深蓝西装配红色领带，神情严肃", ["职场", "男性"]),
    pub("paladin", "圣骑士", "成年男性，金色卷发，穿银白色全身板甲，肩甲带狮首纹样，背负长盾", ["奇幻", "男性"]),
    pub("arcanist", "奥术术士", "中老年男性，灰白长发，穿紫色长袍配深紫披风，手持法杖，杖顶镶蓝色晶石", ["奇幻", "男性"]),
    pub("elf-ranger", "精灵游侠", "成年女性，银白长发，尖耳，穿绿色斗篷与皮质护甲，背负长弓", ["奇幻", "女性"]),
];

type SubjectStore = {
    personal: Subject[];
    selectedId: string | null;
    addPersonal: (input: Omit<Subject, "id" | "type" | "createdAt">) => Subject;
    updatePersonal: (id: string, patch: Partial<Omit<Subject, "id" | "type">>) => void;
    removePersonal: (id: string) => void;
    toggleStar: (id: string) => void;
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
            addPersonal: (input) => {
                const subject: Subject = { ...input, id: newId(), type: "personal", createdAt: Date.now() };
                set((state) => ({ personal: [subject, ...state.personal] }));
                return subject;
            },
            updatePersonal: (id, patch) =>
                set((state) => ({ personal: state.personal.map((item) => (item.id === id ? { ...item, ...patch } : item)) })),
            removePersonal: (id) =>
                set((state) => ({
                    personal: state.personal.filter((item) => item.id !== id),
                    selectedId: state.selectedId === id ? null : state.selectedId,
                })),
            toggleStar: (id) => set((state) => ({ personal: state.personal.map((item) => (item.id === id ? { ...item, starred: !item.starred } : item)) })),
            select: (id) => set({ selectedId: id }),
        }),
        { name: "infinite-canvas:subject_store" },
    ),
);

/** 按 id 找主体（个人优先，其次公共）。 */
export function resolveSubject(id: string | null, personal: Subject[]): Subject | null {
    if (!id) return null;
    return personal.find((item) => item.id === id) ?? PUBLIC_SUBJECTS.find((item) => item.id === id) ?? null;
}

/**
 * 「公共主体」分类的内容 = 系统内置 + 用户主动公开的个人主体。
 * 公开后其他使用者（同一环境的其他账号/使用者）在公共主体库里可直接选用。
 */
export function publicSubjectList(personal: Subject[]): Subject[] {
    return [...PUBLIC_SUBJECTS, ...personal.filter((item) => item.visibility === "public")];
}
