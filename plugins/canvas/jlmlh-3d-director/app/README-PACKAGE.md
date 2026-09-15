# 一力三期BMS - 故事AI导演工作台 打包指南

## 快速打包

双击运行 `build-electron.bat`，等待完成即可。

## 打包步骤详解

### 1. 环境准备

确保已安装：
- Node.js 16+（下载地址：https://nodejs.org）
- npm（随Node.js一起安装）

### 2. 安装依赖

```bash
npm install
```

### 3. 构建前端

```bash
npm run build
```

### 4. 打包exe

```bash
npm run electron:build:win
```

### 5. 查看结果

打包完成后，在 `release` 目录找到：
- `故事AI导演工作台 Setup 1.0.0.exe`（安装包）

## 给用户使用

用户只需：
1. 双击安装包
2. 按提示安装（可自定义安装目录）
3. 桌面出现快捷方式
4. 双击打开即可使用

## 应用特性

- ✅ 无需安装任何运行时
- ✅ 桌面原生窗口体验
- ✅ 自动创建桌面快捷方式
- ✅ 支持自定义安装目录
- ✅ 支持开始菜单快捷方式

## 自定义配置

### 修改窗口大小

编辑 `electron/main.js`：
```javascript
mainWindow = new BrowserWindow({
  width: 1400,   // 修改宽度
  height: 900,   // 修改高度
  // ...
});
```

### 修改应用名称

编辑 `package.json`：
```json
{
  "build": {
    "productName": "你的应用名称",
    // ...
  }
}
```

### 修改应用图标

1. 准备一个 256x256 的 PNG 图标
2. 重命名为 `icon.png`
3. 放到 `public` 目录
4. 重新打包

## 常见问题

### Q: 打包失败怎么办？

A: 尝试以下步骤：
1. 删除 `node_modules` 文件夹
2. 删除 `package-lock.json` 文件
3. 重新运行 `npm install`
4. 再次打包

### Q: exe文件太大？

A: Electron应用包含完整的Chromium浏览器引擎，这是正常的。打包后约100-150MB。

### Q: 安装后打不开？

A: 尝试：
1. 右键以管理员身份运行
2. 检查杀毒软件是否拦截
3. 确保系统是Windows 10+

### Q: 如何开发调试？

A: 运行：
```bash
npm run electron:dev
```

这会同时启动开发服务器和Electron窗口，支持热更新。

## 技术说明

- **前端框架**: React + TypeScript
- **3D引擎**: Three.js + React Three Fiber
- **构建工具**: Vite
- **桌面框架**: Electron
- **打包工具**: electron-builder

## 文件结构

```
storyai-3d-director-desk/
├── electron/              # Electron主进程
│   ├── main.js           # 主进程入口
│   └── preload.js        # 预加载脚本
├── src/                  # 前端源码
├── dist/                 # 构建输出
├── release/              # 打包输出
├── package.json          # 项目配置
├── build-electron.bat    # 一键打包脚本
└── README-PACKAGE.md     # 本文档
```

## 更新日志

### v1.0.0
- 初始版本
- 支持Windows打包
- 支持桌面快捷方式
