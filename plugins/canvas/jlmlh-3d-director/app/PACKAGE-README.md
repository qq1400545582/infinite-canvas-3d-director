# 打包成exe说明

## 快速打包（推荐）

双击运行 `build-electron.bat`，自动完成所有步骤。

打包完成后，exe文件在 `release` 目录中。

## 手动打包步骤

### 1. 安装依赖
```bash
npm install
```

### 2. 构建前端
```bash
npm run build
```

### 3. 打包exe
```bash
npm run electron:build:win
```

## 打包结果

- **安装包**: `release/故事AI导演工作台 Setup 1.0.0.exe`
- **用户操作**: 双击安装 → 桌面出现快捷方式 → 双击打开使用

## 注意事项

1. **首次打包**需要下载Electron，可能需要几分钟
2. **打包后大小**约100-150MB
3. **无需安装**任何运行时，用户直接使用

## 开发调试

如果需要开发调试，运行：
```bash
npm run electron:dev
```

这会同时启动Vite开发服务器和Electron窗口。

## 常见问题

### Q: 打包失败怎么办？
A: 确保已安装Node.js 16+，然后删除 `node_modules` 重新安装。

### Q: exe文件太大？
A: Electron应用包含完整的Chromium浏览器，这是正常的。

### Q: 如何修改应用图标？
A: 替换 `public/icon.png` 文件，然后重新打包。

### Q: 如何修改窗口大小？
A: 编辑 `electron/main.js` 中的 `width` 和 `height` 参数。
