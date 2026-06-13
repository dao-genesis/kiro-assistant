@echo off
chcp 65001 >nul 2>&1
echo ══════════════════════════════════════════════════════════
echo   道Agent v12.6.0 · Kiro · 道法自然 · 无为而无以为
echo   通用安装: 自动检测Kiro路径 · 覆盖内置扩展 · 零配置
echo ══════════════════════════════════════════════════════════
echo.

:: 1. 杀Kiro和旧proxy
echo [1/5] 停止Kiro和旧proxy进程...
taskkill /IM Kiro.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
:: 杀proxy进程 (node.exe with kiro-dao-proxy in cmdline)
for /f "tokens=2" %%p in ('wmic process where "name='node.exe'" get processid /format:list 2^>nul ^| findstr /i "ProcessId"') do (
    wmic process where "processid=%%p and commandline like '%%kiro-dao-proxy%%'" call terminate >nul 2>&1
)
timeout /t 2 /nobreak >nul

:: 2. 检测Kiro安装路径
echo [2/5] 检测Kiro安装路径...
set "KIRO_ROOT="
:: 常见路径
for %%d in (
    "D:\Kiro"
    "C:\Kiro"
    "%LOCALAPPDATA%\Programs\Kiro"
    "%PROGRAMFILES%\Kiro"
) do (
    if exist %%~d\Kiro.exe (
        set "KIRO_ROOT=%%~d"
        goto :found_kiro
    )
)
:: 搜索PATH
for /f "tokens=*" %%p in ('where Kiro.exe 2^>nul') do (
    for %%d in ("%%~dp..") do set "KIRO_ROOT=%%~fd"
    goto :found_kiro
)
echo ⚠️ 未找到Kiro安装路径 — 请手动指定:
echo   set KIRO_ROOT=D:\Kiro
echo   然后重新运行
pause
exit /b 1

:found_kiro
echo   ✓ Kiro: %KIRO_ROOT%

:: 3. 覆盖内置扩展
echo [3/5] 覆盖内置kiro-dao-agent扩展...
set "BUILTIN=%KIRO_ROOT%\resources\app\extensions\kiro-dao-agent"
if not exist "%BUILTIN%" mkdir "%BUILTIN%"
if not exist "%BUILTIN%\vendor" mkdir "%BUILTIN%\vendor"
if not exist "%BUILTIN%\media" mkdir "%BUILTIN%\media"
if not exist "%BUILTIN%\vendor\bundled-origin" mkdir "%BUILTIN%\vendor\bundled-origin"

:: 复制核心文件
copy /Y "%~dp0extension.js" "%BUILTIN%\extension.js" >nul
copy /Y "%~dp0package.json" "%BUILTIN%\package.json" >nul
copy /Y "%~dp0vendor\kiro-dao-proxy.js" "%BUILTIN%\vendor\kiro-dao-proxy.js" >nul
copy /Y "%~dp0vendor\_upstream_relay.js" "%BUILTIN%\vendor\_upstream_relay.js" >nul 2>nul
copy /Y "%~dp0vendor\bundled-origin\*.*" "%BUILTIN%\vendor\bundled-origin\" >nul 2>nul
copy /Y "%~dp0media\*.*" "%BUILTIN%\media\" >nul 2>nul
echo   ✓ 扩展文件已覆盖

:: 4. 清理旧版本
echo [4/5] 清理旧版本...
:: 删除用户目录下的旧版本
for /d %%d in ("%APPDATA%\Kiro\User\extensions\kiro-dao-agent-*") do (
    rd /s /q "%%d" 2>nul
    echo   ✓ 删除 %%~nxd
)
for /d %%d in ("%APPDATA%\Kiro\User\extensions\dao-agi.kiro-dao-agent-*") do (
    rd /s /q "%%d" 2>nul
    echo   ✓ 删除 %%~nxd
)
:: 删除内置目录中的备份
for /d %%d in ("%BUILTIN%-*") do (
    rd /s /q "%%d" 2>nul
    echo   ✓ 删除 %%~nxd
)

:: 5. 验证
echo [5/5] 验证安装...
if exist "%BUILTIN%\extension.js" (
    echo   ✓ extension.js
) else echo   ✗ extension.js 缺失!
if exist "%BUILTIN%\vendor\kiro-dao-proxy.js" (
    echo   ✓ kiro-dao-proxy.js
) else echo   ✗ kiro-dao-proxy.js 缺失!
if exist "%BUILTIN%\package.json" (
    echo   ✓ package.json
) else echo   ✗ package.json 缺失!

echo.
echo ══════════════════════════════════════════════════════════
echo   ✓ 安装完成 · 启动Kiro后自动激活
echo   道法自然 · 无为而无以为
echo ══════════════════════════════════════════════════════════
pause
