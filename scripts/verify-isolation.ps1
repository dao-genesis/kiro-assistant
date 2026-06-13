# ═══════════════════════════════════════════════════════════════════════════
# verify-isolation.ps1 · 验证本源隔离是否生效 (Windows · PowerShell)
# ═══════════════════════════════════════════════════════════════════════════
# 不臆造成功: 每项都真打 proxy 的 /origin 端点取证，PASS/FAIL 据实而报。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\verify-isolation.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify-isolation.ps1 -Port 11440
#
# 校验项:
#   L1 端口存活    — 扫描 11436..11485 找到正在监听的 proxy，/origin/ping 返回 ok
#   L2 纯道注入    — /origin/custom_sp 的 default_sp 以纯道头起始，且全文不含 "Kiro"
#   L3 经文落地    — default_sp 含帛书老子 + 阴符经原文片段
#   L4 模式        — 处于 invert (本源隔离) 模式
# 退出码: 全通过 0, 否则 1。
# ═══════════════════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [int]$Port = 0
)
$ErrorActionPreference = "SilentlyContinue"
$pass = 0; $fail = 0
function Pass($m) { Write-Host "  PASS  $m" -ForegroundColor Green; $script:pass++ }
function Fail($m) { Write-Host "  FAIL  $m" -ForegroundColor Red;   $script:fail++ }

Write-Host "============================================================"
Write-Host "  Kiro Assistant · 本源隔离验证"
Write-Host "============================================================"

function Get-Ping($p) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$p/origin/ping" -TimeoutSec 2 -Method Get
  } catch { return $null }
}

# ── L1: 找到存活的 proxy 端口 ──
$ping = $null
if ($Port -gt 0) { $ping = Get-Ping $Port }
if (-not $ping) {
  for ($p = 11436; $p -le 11485; $p++) {
    $r = Get-Ping $p
    if ($r -and $r.ok) { $Port = $p; $ping = $r; break }
  }
}
if ($ping -and $ping.ok) {
  Pass "L1 proxy 存活 @ 127.0.0.1:$Port (version=$($ping.version), canon=$($ping.canon_chars)字)"
} else {
  Fail "L1 未找到存活的 proxy (扫描 11436..11485)。先在 Kiro 命令面板执行 'Kiro Assistant: Start (invert)'"
  Write-Host "------------------------------------------------------------"
  Write-Host "  结果: PASS=$pass FAIL=$fail"
  exit 1
}

# ── L4: 模式 ──
if ($ping.mode -eq "invert") { Pass "L4 模式 = invert (本源隔离)" }
else { Fail "L4 模式 = $($ping.mode) (应为 invert; 用 'Kiro Assistant: Toggle Mode' 切换)" }

# ── L2 + L3: 取有效注入 SP (强制 UTF-8 解码以防 PS5.1 乱码) ──
$sp = $null
try {
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $raw = $wc.DownloadString("http://127.0.0.1:$Port/origin/custom_sp")
  $cs = ConvertFrom-Json $raw
  if ($cs.default_sp) { $sp = $cs.default_sp } elseif ($cs.sp) { $sp = $cs.sp }
} catch {}

if (-not $sp) {
  Fail "L2 取不到注入 SP (/origin/custom_sp 无 default_sp)"
} else {
  $pureHead = [char]0x4f60 + [char]0x672c + [char]0x7121 + [char]0x540d  # 你本無名
  $startsPure = $sp.StartsWith($pureHead)
  $hasKiro = ($sp -match "(?i)kiro")
  if ($startsPure -and -not $hasKiro) {
    Pass "L2 纯道注入: SP 以纯道头起始且全文 0 处 'Kiro' ($($sp.Length) 字)"
  } else {
    Fail "L2 纯道注入: startsPureHeader=$startsPure containsKiro=$hasKiro"
  }

  # L3 经文片段 (帛书老子开篇 '上德不德' + 阴符经 '觀天之道')
  $deFrag   = [char]0x4e0a + [char]0x5fb7 + [char]0x4e0d + [char]0x5fb7         # 上德不德
  $yinFrag  = [char]0x89c0 + [char]0x5929 + [char]0x4e4b + [char]0x9053         # 觀天之道
  $hasDe  = $sp.Contains($deFrag)
  $hasYin = $sp.Contains($yinFrag)
  if ($hasDe -and $hasYin) { Pass "L3 经文落地: 帛书《老子》+ 道藏《阴符经》原文均在注入 SP 中" }
  else { Fail "L3 经文落地: hasLaozi=$hasDe hasYinfu=$hasYin" }
}

Write-Host "------------------------------------------------------------"
if ($fail -eq 0) {
  Write-Host "  结果: 全部通过 PASS=$pass FAIL=0 · 道法自然" -ForegroundColor Green
  exit 0
} else {
  Write-Host "  结果: PASS=$pass FAIL=$fail" -ForegroundColor Yellow
  exit 1
}
