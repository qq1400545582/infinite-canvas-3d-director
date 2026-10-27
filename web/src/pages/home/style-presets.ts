/**
 * 首页画风库预设。
 *
 * 说明：参考站（Seko）的画风是登录后异步拉取的影视风格模型，本地没有对应资源；
 * 这里用 15 个可作为「提示词风格词」真实生效的预设，外观用各自的风格色卡呈现代替缩略图。
 * 名称走 i18n（home.composer.styles.<id>），中英文都能切。
 */
export type StylePreset = {
    id: string;
    /** 预览底色，贴合该风格的调性 */
    preview: string;
};

export const STYLE_PRESETS: StylePreset[] = [
    { id: "retroWuxia", preview: "linear-gradient(140deg,#3b2a1a 0%,#8c6a3f 55%,#191310 100%)" },
    { id: "modern3d", preview: "linear-gradient(140deg,#0d1b2a 0%,#2e6b8c 55%,#9fd3e8 100%)" },
    { id: "fantasyComic", preview: "linear-gradient(140deg,#2a1240 0%,#6b3fa0 55%,#c9a0ff 100%)" },
    { id: "costumeFilm", preview: "linear-gradient(140deg,#3a2418 0%,#8a5a3b 55%,#d9b08c 100%)" },
    { id: "portraitStudio", preview: "linear-gradient(140deg,#3a1f22 0%,#8c4a4f 55%,#e8b4b8 100%)" },
    { id: "softBeauty", preview: "linear-gradient(140deg,#3a2f36 0%,#a3808f 55%,#f0dbe4 100%)" },
    { id: "guofengInk", preview: "linear-gradient(140deg,#15291f 0%,#3f6b52 55%,#a8c9a0 100%)" },
    { id: "cinematic", preview: "linear-gradient(140deg,#2b1d0e 0%,#8a5a1f 55%,#e0b060 100%)" },
    { id: "urbanPortrait", preview: "linear-gradient(140deg,#1c2430 0%,#4a5b6e 55%,#9aa8b8 100%)" },
    { id: "cyberNeon", preview: "linear-gradient(140deg,#12001f 0%,#ff2e88 55%,#00e5ff 100%)" },
    { id: "orientalInk", preview: "linear-gradient(140deg,#101012 0%,#3a3a3e 55%,#d8d8dc 100%)" },
    { id: "filmGrain", preview: "linear-gradient(140deg,#2a2016 0%,#6b5a3f 55%,#c8b48c 100%)" },
    { id: "animeCel", preview: "linear-gradient(140deg,#0f2a4a 0%,#2f7fd0 55%,#ffd34d 100%)" },
    { id: "lineArt", preview: "linear-gradient(140deg,#e9e9ea 0%,#b9b9bd 55%,#6e6e74 100%)" },
    { id: "moodyDark", preview: "linear-gradient(140deg,#0b0a0f 0%,#2a1f3a 55%,#4a3a6a 100%)" },
];
