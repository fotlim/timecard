# 挂卡时间轴 · 手机端（Android）

**Capacitor 7 + React + Vite**，和桌面端共用 `@timecard/shared` 的数据模型与同步协议。
单屏「今日」结构，底部抽屉交付新建 / 编辑 / 设置。

## 构建 APK

需要 **JDK 21** 与 **Android SDK**：

```bash
# 在仓库根目录
pnpm install
pnpm --filter @timecard/mobile build

cd apps/mobile
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

release 包可 `./gradlew assembleRelease`（默认开启 R8 混淆 + 资源裁剪；未签名，装机前需自行签名）。

## 结构

```
src/
├─ App.tsx      单屏应用 + 各底部抽屉（新建 / 编辑 / 搜索 / 设置）
├─ store.ts     localStorage 数据层 + Outbox
├─ sync.ts      同步引擎（与桌面端同一套协议 + 退避重试）
└─ styles/     三套皮肤的移动端样式
android/        Capacitor 生成的 Android 工程
```

## 界面要点

- 今日卡片列表 + 逾期区；日期 `‹ ›` 逐天翻
- **下拉刷新同步**（列表在顶部时下拉松手触发一次同步）
- 全库搜索（按标题 / 分类 / **条目内容**，命中条目显示片段）、归档 / 取消归档
- **硬件返回键**：先关抽屉 / 筛选，没有才退出
- 同步失败自动退避重试（3s→60s），前台每 60s 主动拉取

## 三套皮肤

`organic` / `brutal` / `neo`，与桌面端、控制台保持一致。
