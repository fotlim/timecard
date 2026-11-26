# ============================================================
# 验收脚本：类型检查 → 编译 → 截图
#   竖屏今日 x3 皮肤 + 宽屏周视图 + 真浮窗 + 设置窗口
# 用法： powershell -ExecutionPolicy Bypass -File _shoot.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

# electron 被当成纯 Node 跑的话会崩，先清掉
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
foreach ($v in 'TIMECARD_SHOT','TIMECARD_SHOT_QUICK','TIMECARD_SHOT_SETTINGS','TIMECARD_BOOT','TIMECARD_WIDE') {
  Remove-Item "env:$v" -ErrorAction SilentlyContinue
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Resolve-Path (Join-Path $here '..\..')
# node 在哪由环境决定（别把某台机器的绝对路径写进仓库）：
#   要么设 TC_NODE_BIN，要么让 node 已经在 PATH 里
$nodeBin = $env:TC_NODE_BIN
if (-not $nodeBin) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeBin = Split-Path -Parent $cmd.Source }
}
if (-not $nodeBin) { throw '找不到 node —— 先装 Node 并放进 PATH，或设 TC_NODE_BIN 指向它的 bin 目录' }
$env:PATH = "$nodeBin;" + $env:PATH

$tsc = Join-Path $workspace 'node_modules\typescript\bin\tsc'
$evite = Join-Path $here 'node_modules\electron-vite\bin\electron-vite.js'
$electron = Join-Path $workspace 'node_modules\.pnpm\electron@45.4.1\node_modules\electron\dist\electron.exe'

foreach ($p in @($tsc, $evite, $electron)) {
  if (-not (Test-Path $p)) { throw "缺少 $p —— 先跑 pnpm install，并按 README 恢复 electron 二进制" }
}

Write-Host '--- typecheck ---'
& node $tsc -p (Join-Path $here 'tsconfig.json') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'renderer typecheck 失败' }
& node $tsc -p (Join-Path $here 'tsconfig.node.json') --noEmit
if ($LASTEXITCODE -ne 0) { throw 'main/preload typecheck 失败' }

Write-Host '--- build ---'
& node $evite build | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'build 失败' }

$cases = @(
  @{ boot = 'today/organic'; file = '_shot_today_organic.png'; wide = $false; quick = $null;                   settings = $null },
  @{ boot = 'today/brutal';  file = '_shot_today_brutal.png';  wide = $false; quick = $null;                   settings = $null },
  @{ boot = 'today/neo';     file = '_shot_today_neo.png';     wide = $false; quick = $null;                   settings = $null },
  @{ boot = 'week/organic';  file = '_shot_week.png';          wide = $true;  quick = $null;                   settings = $null },
  @{ boot = 'quick/organic'; file = '_shot_quick.png';         wide = $true;  quick = '_shot_float.png';       settings = $null },
  @{ boot = 'quick/brutal';  file = $null;                     wide = $false; quick = '_shot_float_brutal.png'; settings = $null },
  @{ boot = 'quick/neo';     file = $null;                     wide = $false; quick = '_shot_float_neo.png';    settings = $null },
  @{ boot = 'today/organic'; file = $null;                     wide = $false; quick = $null;                   settings = '_shot_settings.png' }
)

Write-Host '--- shots ---'
foreach ($c in $cases) {
  if ($c.wide) { $env:TIMECARD_WIDE = '1' } else { Remove-Item env:TIMECARD_WIDE -ErrorAction SilentlyContinue }
  $env:TIMECARD_BOOT = $c.boot

  # 每轮先清空三个截图变量，避免上一轮的残留把旧图当成本轮结果（之前 neo 就这么翻过车）
  Remove-Item env:TIMECARD_SHOT, env:TIMECARD_SHOT_QUICK, env:TIMECARD_SHOT_SETTINGS -ErrorAction SilentlyContinue

  $targets = @()
  if ($c.file) {
    $p1 = Join-Path $here $c.file
    if (Test-Path $p1) { Remove-Item $p1 -Force }
    $env:TIMECARD_SHOT = $p1
    $targets += @{ path = $p1; name = $c.file }
  }
  if ($c.quick) {
    $p2 = Join-Path $here $c.quick
    if (Test-Path $p2) { Remove-Item $p2 -Force }
    $env:TIMECARD_SHOT_QUICK = $p2
    $targets += @{ path = $p2; name = $c.quick }
  }
  if ($c.settings) {
    $p3 = Join-Path $here $c.settings
    if (Test-Path $p3) { Remove-Item $p3 -Force }
    $env:TIMECARD_SHOT_SETTINGS = $p3
    $targets += @{ path = $p3; name = $c.settings }
  }

  # 用 Start-Process -Wait：既能等到进程真结束（GUI 子系统程序 & 不会阻塞），
  # 又避开 PS 5.1 把原生 stderr 当致命错误的问题
  Start-Process -FilePath $electron -ArgumentList $here -Wait -NoNewWindow -ErrorAction SilentlyContinue

  foreach ($t in $targets) {
    if (Test-Path $t.path) {
      Write-Host ("  OK   {0,-28} {1,7:N0} KB" -f $t.name, ((Get-Item $t.path).Length / 1KB))
    } else {
      Write-Host ("  MISS {0}" -f $t.name)
    }
  }
}

foreach ($v in 'TIMECARD_SHOT','TIMECARD_SHOT_QUICK','TIMECARD_SHOT_SETTINGS','TIMECARD_BOOT','TIMECARD_WIDE') {
  Remove-Item "env:$v" -ErrorAction SilentlyContinue
}
Write-Host 'done'