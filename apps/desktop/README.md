# 挂卡时间轴 · 桌面端（Windows）

基于 **Electron + React + Vite** 的桌面应用。和手机端共用 `@timecard/shared` 的数据模型与同步协议。

## 运行 / 打包

```bash
# 在仓库根目录
pnpm install
pnpm --filter @timecard/desktop dev     # 开发
pnpm --filter @timecard/desktop dist    # 打 Windows 安装包（NSIS）
```

## 结构

```
src/
├─ main/       主进程：窗口、托盘、全局快捷键、本地存储、同步引擎
├─ preload/    contextBridge 暴露给渲染层的受控 API
└─ renderer/   React 界面：今日视图 / 周视图 / 浮窗 / 设置，三套皮肤
```

## 界面要点

- **今日 / 周视图**：按窗口宽度自动切换（竖屏今日、横屏周）。`←/→` 逐天翻、`Home` 回今天
- **挂一张浮窗**：全局快捷键 `Ctrl+Shift+Space` 呼出，置顶无边框，`Esc` 收起
- **全库搜索**：`Ctrl+F` 或标题栏放大镜，按标题 / 分类 / **条目内容**搜全部卡片，命中条目会显示片段
- **卡片编辑**：标题、分类、条目勾选、改期；支持拖拽改期、归档、删除（可撤销）
- **同步**：离线优先，后台自动推送/拉取，失败退避重试；标题栏状态点点一下即「立即同步」；本地落盘失败会在界面提示
- **开机自启**：设置 → 行为里可开关（打包版生效）

## 三套皮肤

`organic`（自然有机）/ `brutal`（野兽派）/ `neo`（新拟物质），与手机端、控制台保持一致。

## 验收脚本

仓库内附若干 `_verify-*.js` 剧本（起真进程、走真 HTTP / CDP），覆盖编辑、浮窗、键盘切天、搜索、归档、保存失败、同步体验等。运行需要先构建 `out/`：

```bash
pnpm --filter @timecard/desktop build
node _verify-shell.js     # 例：设置窗口 / 托盘 / 拖拽区
```
