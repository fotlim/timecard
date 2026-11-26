# 使用说明

> 面向「装好了想用起来」的人。安装包怎么下、怎么装，见 [README 的下载安装](../README.md#下载安装)。

---

## 1. 三分钟上手

1. 装桌面端（或手机端），打开就是「今日」：一条时间轴，卡片挂在某一天上
2. 点 **＋ 挂一张**，写标题、可留空的分类、几条子待办 → 保存
3. 卡片的勾选框点一下就完成；全部勾完的卡会自动变「已完成」
4. 想多端同步：先跑起同步服务器（第 4 节），再在两端设置里填同一个地址 + 令牌（第 5 节）

> 时间轴不是列表：**今天该做什么、哪张逾期了**，一屏就能看清。

---

## 2. 桌面端（Windows）

### 2.1 挂卡与改卡

| 想做的事 | 怎么做 |
|---|---|
| 挂一张新卡 | 界面里的 **＋ 挂一张**，或按 `Ctrl+Shift+Space` 呼出浮窗直接写 |
| 改一张卡 | 点卡片 → 编辑器（标题 / 分类 / 条目 / 改期 / 卡片主色） |
| 改期 | 编辑器里选日期，或**直接把卡片拖动**到另一天 |
| 勾完成 | 点条目左边的方框；「全部打勾 / 取消」在卡片菜单里 |
| 归档 | 卡片菜单 → 归档。归档的卡不再占时间轴，但**搜索还能找到**；可在编辑器里取消归档 |
| 删除 | 卡片菜单 → 删除（软删除，界面右下角有「撤销」） |

### 2.2 键盘与浮窗

- `←` / `→` 逐天翻，`Home` 回到今天
- `Ctrl+F` 全库搜索：标题、分类、**条目内容**都能搜，命中条目会单独标出来
- `Ctrl+Shift+Space` 呼出/收起浮窗：置顶、无边框、`Esc` 收起；设置里能改快捷键和浮窗贴哪一边
- 快捷键被别人占用时，设置里会直接标红提示「按下无反应」

### 2.3 三套皮肤

设置 → 外观：**自然有机**（米纸 + 衬线）、**野兽派**（黑线黄底 + 硬投影）、**新拟物质**（同色双向阴影）。三端同一套皮肤，切换即时生效。

### 2.4 设置里的每一项

| 分组 | 项 | 说明 |
|---|---|---|
| 外观 | 皮肤 | 三选一 |
| 浮窗 | 全局快捷键 / 浮窗位置 / 打开浮窗 | 快捷键被占用会提示；位置可选贴左/贴右 |
| 同步 | 启用同步 / 服务器地址 / 访问令牌 | 见第 5 节 |
| 行为 | 关闭窗口时最小化到托盘 / 开机自动启动 | 关掉「最小化到托盘」后点 ✕ 就是退出 |
| 数据 | 当前卡片 / 数据文件 / 导出备份 / 从备份导入 / 重置演示数据 / 清空全部卡片 | 见 2.5 |

### 2.5 备份与导入

- **导出备份**：生成一个 JSON（格式标记 `timecard-backup`）。**备份里不含同步令牌**，可以放心丢网盘
- **从备份导入**：按卡片 `id` 合并 —— 同一张卡取「更新的那份」，**不会清空现有卡片**
- 「清空全部卡片」之后再导入也能救回来：备份里还活着的卡会覆盖本地墓碑
- 数据文件在 `%APPDATA%\Timecard\timecard.json`（设置里点得开目录）

---

## 3. 手机端（Android）

| 想做的事 | 怎么做 |
|---|---|
| 新建 | 底部 **＋**，或列表中的「＋ 挂一张」 |
| 改卡 / 打勾 | 点卡片打开编辑抽屉；条目直接在卡片上点 |
| 翻日期 | 界面里的 `‹` `›`，或底部「日子条」点某天 |
| 看逾期 | 逾期卡片自动带橙色标记并排到前面 |
| 搜索 | 右上角搜索图标：标题 / 分类 / 条目内容 |
| 归档 / 删除 | 编辑抽屉底部：归档；删除会先弹确认条（`删除「标题」？`） |
| 立即同步 | 列表顶部**下拉**（松手触发），或设置 → 立即同步 |
| 退出 | 硬件返回键：先关抽屉/筛选，再退出应用 |

> 手机端本地数据存在应用私有目录里，**卸载即清空**。跨设备靠同步，重要的东西建议在桌面端再导出一份备份。

---

## 4. 跑同步服务器

服务器是一个**零依赖单文件**，有 Node 就能跑。

### 4.1 最快：本机/小主机直接起

```bash
# 从 Releases 下载 Timecard-<版本>-server.mjs
export TIMECARD_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
node Timecard-0.1.4-server.mjs
# 控制台： http://127.0.0.1:8787/
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只想本机用就别改；对外一律走反代/隧道，别裸绑 `0.0.0.0` |
| `TIMECARD_TOKEN` | 无 | **访问令牌**，不设就是完全开放，仅限本地开发 |
| `TIMECARD_DB` | `./data/timecard.sqlite` | 数据库文件路径 |

要求 **Node ≥ 22.5**（用了内置的 `node:sqlite`）。

### 4.2 常驻（systemd user 单元）

```ini
# ~/.config/systemd/user/timecard-sync.service
[Unit]
Description=Timecard sync server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/node /home/你/timecard-sync/server.mjs
WorkingDirectory=/home/你/timecard-sync
Environment=PORT=3701
Environment=HOST=127.0.0.1
Environment=TIMECARD_DB=/home/你/timecard-sync/data/timecard.sqlite
EnvironmentFile=/home/你/.config/timecard-sync/env   # 里面放 TIMECARD_TOKEN=...
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now timecard-sync
loginctl enable-linger "$USER"   # 断线也不被杀
```

### 4.3 给别人/别的网络用

- **隧道/反代**（推荐）：服务仍绑 `127.0.0.1`，用 Cloudflare Tunnel、Caddy、nginx 把 HTTPS 转发进来
- **局域网**：改成绑内网地址 + 防火墙只放行内网段
- 无论哪种，`/api/admin/*` 与同步接口都用**同一个 Bearer 令牌**保护；控制台页面本身只是个填令牌的壳

### 4.4 Cloudflare Workers + D1

```bash
npx wrangler d1 create timecard     # 把 database_id 填进 wrangler.toml
npx wrangler secret put TIMECARD_TOKEN
npx wrangler deploy
```

### 4.5 控制台能干什么

浏览器打开服务器根路径，输入令牌后可以：

- 看运行状态（版本、内存、数据库体积、最近一分钟推/拉次数、事件缓冲）
- 卡片浏览：按状态筛（全部 / 进行中 / 已完成 / 已归档 / 已删除）、按标题/分类/条目搜
- 打开单卡详情：条目、时间、`rev`、`seq`、原始 JSON，可**软删除 / 恢复**
- 实时动态：推送、拉取、控制台操作，可按类型或设备过滤
- 设备列表：哪台设备推了多少、有几条失败
- **导出全部** JSON、整理数据库

### 4.6 备份、升级、卸载

```bash
# 备份（先停，避免 WAL 下拷到不一致快照）
systemctl --user stop timecard-sync
cp ~/timecard-sync/data/timecard.sqlite ~/timecard-sync/data/backup-$(date +%F).sqlite
systemctl --user start timecard-sync

# 升级：覆盖 server.mjs → 重启
systemctl --user restart timecard-sync
curl -s http://127.0.0.1:3701/api/health   # 看 version 是否变了

# 卸载：停服务 + 删单元 + 删目录（数据一起没）
systemctl --user disable --now timecard-sync
rm -f ~/.config/systemd/user/timecard-sync.service && systemctl --user daemon-reload
rm -rf ~/timecard-sync ~/.config/timecard-sync
```

---

## 5. 让三端同步起来

### 5.1 桌面端

设置 → **同步**：勾「启用同步」→ 填服务器地址（如 `https://sync.example.com`，不要带结尾斜杠和 `/api`）+ 访问令牌 → 顶部状态点一下或按需要「立即同步」。

### 5.2 手机端

设置 → **同步**：同样的地址和令牌 → 下拉列表顶部或点「立即同步」。

### 5.3 它怎么工作的

- **离线优先**：改动先落本地，再进「待推送队列」（Outbox）；断网照常用，联网自动补推
- **增量拉取**：服务器给每张卡一个自增游标 `seq`，客户端只拉「我还没见过的」
- **冲突**：最后写入者胜 —— 先比 `updatedAt`，相同再比 `deviceId` 字典序。三端跑同一个 `isNewer()`，不会来回震荡
- **永不物理删除**：删除只是打上 `deletedAt`，否则卡片会在别的设备上「复活」

> 冲突粒度是**整张卡**：两端同时改同一张卡的不同条目，会有一端被整体覆盖。想避免就尽量别在两端同时改同一张卡。

### 5.4 令牌换/泄露怎么办

1. 改服务器上的 `TIMECARD_TOKEN` 并重启
2. 三端设置里重新填新令牌
3. 旧令牌立刻失效（没有多用户概念，一个令牌 = 一个数据库）

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 同步报 401 | 令牌不对，或服务器换了令牌但客户端没改 |
| 连不上服务器 | 地址末尾多了 `/`；用的是 `http://` 但服务器只开了 HTTPS；隧道没开 |
| 桌面端显示「有改动待推送」一直不消失 | 服务器连不上，改动在队列里等着；能连上后会自动推 |
| 换了服务器，旧改动还在推 | 设置 → 同步 → **清空待推送队列** |
| 手机上装不上 APK（小米提示「解析包错误 33」） | 别从浏览器下载面板直接点开，去 **文件管理 → 下载** 点安装；仍不行就用 `adb install -r` |
| Windows 安装包被 SmartScreen 拦 | 没做代码签名：**更多信息 → 仍要运行** |
| 卡片在一台设备上消失了 | 可能被另一台删除（软删会同步过来）。控制台可以「恢复」这张卡 |
| 时间显示不对 | 卡片存的是时间戳，显示跟系统时区走；跨时区设备看起来会不一样 |

---

## 7. 数据在哪

| 端 | 位置 | 备注 |
|---|---|---|
| 桌面端 | `%APPDATA%\Timecard\timecard.json` | 单文件 JSON；设置里可导出/导入备份 |
| 手机端 | 应用私有目录（WebView localStorage） | 卸载即清空；靠同步或桌面端备份保命 |
| 服务器 | `TIMECARD_DB` 指向的 SQLite 文件 | 一个文件就是全部数据，停服务后直接 `cp` 备份 |

---

## 8. 边界与安全

- 个人自用工具：**一个令牌 = 一个数据库**，没有多用户、配额、限速
- 令牌在客户端本地明文保存，合适放的是待办，不是密码本
- 冲突处理是整卡覆盖（LWW），不是条目级合并
- 暴露到公网前，请在反代/隧道层再加一层访问控制（Cloudflare Access、Basic Auth 等）
