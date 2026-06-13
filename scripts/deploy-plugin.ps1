# ═══════════════════════════════════════════════════════════════════════════
# deploy-plugin.ps1 · Kiro Assistant 冷启动部署 (Windows · PowerShell)
# 道法自然 · 无为而无以为 — 一条命令把扩展落到 Kiro 内置扩展目录并就绪。
# ═══════════════════════════════════════════════════════════════════════════
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-plugin.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-plugin.ps1 -KiroRoot "D:\Kiro"
#
# 做的事 (幂等):
#   1. 停止 Kiro 与旧 proxy 进程
#   2. 自动探测 Kiro 安装根目录 (可用 -KiroRoot 覆盖)
#   3. 覆盖内置扩展 resources\app\extensions\kiro-dao-agent (extension/proxy/经文/媒体)
#   4. 清理用户目录里的旧版本副本
#   5. 校验落地文件 + node --check 语法
# 部署后: 重启 Kiro → 命令面板 "Kiro Assistant: Start (invert)"。
# ═══════════════════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$KiroRoot = ""
)
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot   # repo root (scripts/ 的上一级)

function Info($m) { Write-Host "  $m" }
function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }

Write-Host "============================================================"
Write-Host "  Kiro Assistant · 冷启动部署 v12.6.0 · 本源隔离 · 唯走 AWS Q"
Write-Host "============================================================"

# ── 1. 停止 Kiro 与旧 proxy ──
Step "停止 Kiro 与旧 proxy 进程"
Get-Process Kiro -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match "kiro-dao-proxy" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Ok "已停止"

# ── 2. 探测 Kiro 安装根 ──
Step "探测 Kiro 安装路径"
if (-not $KiroRoot) {
  $candidates = @(
    "D:\Kiro", "C:\Kiro",
    (Join-Path $env:LOCALAPPDATA "Programs\Kiro"),
    (Join-Path ${env:ProgramFiles} "Kiro")
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c "Kiro.exe"))) { $KiroRoot = $c; break }
  }
  if (-not $KiroRoot) {
    $w = Get-Command Kiro.exe -ErrorAction SilentlyContinue
    if ($w) { $KiroRoot = Split-Path -Parent $w.Source }
  }
}
if (-not $KiroRoot -or -not (Test-Path (Join-Path $KiroRoot "Kiro.exe"))) {
  Warn "未找到 Kiro。请先安装 Kiro，或显式传入 -KiroRoot <path>"
  Warn "例: powershell -ExecutionPolicy Bypass -File scripts\deploy-plugin.ps1 -KiroRoot D:\Kiro"
  exit 1
}
Ok "Kiro: $KiroRoot"

# ── 3. 覆盖内置扩展 ──
Step "覆盖内置 kiro-dao-agent 扩展"
$builtin = Join-Path $KiroRoot "resources\app\extensions\kiro-dao-agent"
New-Item -ItemType Directory -Force -Path $builtin | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $builtin "vendor\bundled-origin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $builtin "media") | Out-Null

Copy-Item (Join-Path $ROOT "extension.js")  (Join-Path $builtin "extension.js")  -Force
Copy-Item (Join-Path $ROOT "package.json")  (Join-Path $builtin "package.json")  -Force
Copy-Item (Join-Path $ROOT "vendor\kiro-dao-proxy.js") (Join-Path $builtin "vendor\kiro-dao-proxy.js") -Force
# 经文 (帛书老子 + 阴符经) — 隔离替换的本源，必须随扩展落地
Copy-Item (Join-Path $ROOT "vendor\bundled-origin\*") (Join-Path $builtin "vendor\bundled-origin\") -Force
Copy-Item (Join-Path $ROOT "media\*") (Join-Path $builtin "media\") -Force -ErrorAction SilentlyContinue
# 可选: 上游中继 (若仓库存在则带上，缺失则 proxy 退回 CONNECT 隧道模式，功能不破)
$relay = Join-Path $ROOT "vendor\_upstream_relay.js"
if (Test-Path $relay) { Copy-Item $relay (Join-Path $builtin "vendor\_upstream_relay.js") -Force }
Ok "扩展文件已覆盖 → $builtin"

# ── 4. 清理用户目录旧版本 ──
Step "清理用户目录旧版本副本"
$userExt = Join-Path $env:APPDATA "Kiro\User\extensions"
if (Test-Path $userExt) {
  Get-ChildItem $userExt -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "kiro-dao-agent" } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; Info "删除 $($_.Name)" }
}
Ok "清理完成"

# ── 5. 校验 ──
Step "校验落地文件 + 语法"
$need = @("extension.js", "package.json", "vendor\kiro-dao-proxy.js",
          "vendor\bundled-origin\_silk_dao.txt", "vendor\bundled-origin\_silk_de.txt",
          "vendor\bundled-origin\_yinfu.txt")
$missing = @()
foreach ($f in $need) { if (-not (Test-Path (Join-Path $builtin $f))) { $missing += $f } }
if ($missing.Count -gt 0) { Warn ("缺失: " + ($missing -join ", ")); exit 1 }
foreach ($js in @("extension.js", "vendor\kiro-dao-proxy.js")) {
  & node --check (Join-Path $builtin $js)
  if ($LASTEXITCODE -ne 0) { Warn "$js 语法校验失败"; exit 1 }
}
Ok "全部文件就位 · 语法通过"

Write-Host "============================================================"
Write-Host "  部署完成。下一步:"
Write-Host "    1) 启动 Kiro"
Write-Host "    2) 命令面板 → 'Kiro Assistant: Start (invert)'"
Write-Host "    3) 重启 Kiro 以加载 endpoints 锚定"
Write-Host "    4) 验证: powershell -ExecutionPolicy Bypass -File scripts\verify-isolation.ps1"
Write-Host "  道法自然 · 无为而无不为"
Write-Host "============================================================"
