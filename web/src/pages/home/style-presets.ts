/**
 * 首页画风库预设（38 种）。
 *
 * 缩略图由用户提供的画风列表截图按网格裁切而来，存放于
 * `web/public/styles/<id>.jpg`（153×124，已去掉截图里原有的名称文字，
 * 名称改由界面自己渲染，避免文字重影）。
 * `id` 同时是图片文件名和 i18n key 后缀：`home.composer.styles.<id>`。
 */
export type StylePreset = { id: string };

export const STYLE_PRESETS: StylePreset[] = [
    { id: "retro-studio" },
    { id: "retro-wuxia-film" },
    { id: "3d-modern" },
    { id: "weird-comic" },
    { id: "filmic" },
    { id: "saturated-real" },
    { id: "soft-real" },
    { id: "guofeng-drama" },
    { id: "youth-comic" },
    { id: "cool-urban-comic" },
    { id: "gorgeous-toon" },
    { id: "2d-guofeng" },
    { id: "3d-guofeng" },
    { id: "live-guofeng" },
    { id: "blackwhite-film" },
    { id: "hongkong-retro" },
    { id: "youth-film" },
    { id: "retro-dv" },
    { id: "q-3d-cartoon" },
    { id: "fresh-comic" },
    { id: "american-3d" },
    { id: "sketch" },
    { id: "watercolor" },
    { id: "gongbi" },
    { id: "oil" },
    { id: "felt" },
    { id: "clay" },
    { id: "blocks" },
    { id: "surreal" },
    { id: "y2k-collage" },
    { id: "stage" },
    { id: "retro-neon-city" },
    { id: "retro-cyber-anime" },
    { id: "futurism" },
    { id: "western-real" },
    { id: "werewolf" },
    { id: "western-fantasy" },
    { id: "fruit-man" },
];
