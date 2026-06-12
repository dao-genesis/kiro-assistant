# 冷启动手册 · Cold-Start Guide (for the next Agent)

> 道法自然。把"从一台干净的 Windows 机 → 跑出可验证的本源隔离"这条最耗时的长链路，
> 一次趟通并固化为流程，让下一个 Agent 不必反复摸索。
>
> **核心目标只有一个**：不路由到任何第三方模型（仍走 AWS Q —— Kiro 官方后端），
> 在请求侧就地把官方注入的系统提示/身份/工具规则**隔离替换**为帛书《老子》道藏《阴符经》
> + 最简必要工具。`无为而无不为`。

---

## 0. 环境底座
- OS：Windows（开发实测 Windows Server 2022）；Home：`C:\Users\<user>`。
- 预装 Node 20.x（`node --check` 用于语法校验，proxy 自身就是 Node 脚本）。
- Git 就绪。打包 VSIX 用 `@vscode/vsce`（见 `package.json` 的 `scripts.package`）。

## 1. 装 Kiro
- 安装 Kiro IDE（https://kiro.dev ）。常见落点：`%LOCALAPPDATA%\Programs\Kiro`、`D:\Kiro`、`C:\Kiro`。
- 关键目录：
  - 内置扩展：`<KiroRoot>\resources\app\extensions\kiro-dao-agent`（**本扩展的落点**）。
  - 用户设置：`%APPDATA%\Kiro\User\settings.json`（proxy 锚定 `codewhisperer.config.endpoints` 写这里）。

## 2. 登录账号（拿到可用的 AWS Q 凭证）
- Kiro 启动后按其引导登录，登录态由 Kiro 自身持有；proxy **不碰登录**，只在请求经过时复用 Kiro 已有的 `authorization` 头。
- 坑：部分账号会被 Kiro 后端拒绝（换可用账号即可）。手输邮箱时 `@` 常被终端吞，用剪贴板粘贴。
- 验证登录：Kiro 内能正常发起一次对话即说明 AWS Q 凭证可用。

## 3. 部署插件（一条命令）
```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-plugin.ps1
# 指定非默认安装路径:
powershell -ExecutionPolicy Bypass -File scripts\deploy-plugin.ps1 -KiroRoot D:\Kiro
```
`deploy-plugin.ps1` 幂等完成：停 Kiro/旧 proxy → 探测 KiroRoot → 覆盖内置扩展（extension/proxy/**经文**/媒体）
→ 清旧版本 → 校验落地 + `node --check`。

> 纯 Windows 直装也可用仓库根的 `install.cmd`（等价逻辑的 .cmd 版）。

## 4. 启动隔离 + 重启
1. 启动 Kiro。
2. 命令面板 → **`Kiro Assistant: Start (invert)`** —— 起本地 proxy 并把 `codewhisperer.config.endpoints` 锚到 `http://127.0.0.1:<port>`。
3. **重启 Kiro**（让 endpoints 锚定生效）。
- 端口：默认按用户名 FNV-1a 落在 `11436..11485`（多账号天然隔离），也可用设置 `kiro.dao.port` 固定。
- LSP 报 "connection to server is erroring" 在 invert 反代下是**预期现象**（代理拦截出站），与隔离无关。

## 5. 验证（不臆造成功）
```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-isolation.ps1
```
逐项打 proxy 的 `/origin` 端点取证：
- **L1** 端口存活（扫描 11436..11485，`/origin/ping` 返回 `ok` + 版本 + 经文字数）。
- **L2** 纯道注入（`default_sp` 以"你本無名…"纯道头起始，且全文 **0 处 "Kiro"**）。
- **L3** 经文落地（注入 SP 含帛书《老子》+ 道藏《阴符经》原文片段）。
- **L4** 处于 `invert`（本源隔离）模式。

GUI 实测补充（人工在 Kiro 对话框里问）：
- 问身份/规则 → 只答遵《老子》《阴符经》之道，不暴露 AWS/Amazon/Kiro 任何具名身份。
- 工具仍可用 → 让它读 README / 搜工作区，实际调用工具而非空谈。
- 隔离落证：每次注入后 proxy 会把发往 AWS Q 的系统提示落到
  `<kiro-dao-agent>\vendor\_dao_isolated_sp.txt`，直接核其"你本無名"开头、零 "Kiro"。

## 6. 关键路径速查
| 用途 | 路径 |
|---|---|
| 代理核心 | `vendor/kiro-dao-proxy.js`（`PROXY_VERSION = 12.1.0`，`invert` / `full` 经文） |
| 扩展宿主 | `extension.js`（fork 代理 + 面板预览，头与 proxy 一致） |
| 经文本源 | `vendor/bundled-origin/_silk_de.txt` `_silk_dao.txt` `_yinfu.txt` |
| 部署 | `scripts/deploy-plugin.ps1`（推荐）/ 根 `install.cmd` |
| 验证 | `scripts/verify-isolation.ps1` |
| 隔离落证 | `<kiro-dao-agent>\vendor\_dao_isolated_sp.txt`、日志 `kiro-dao-proxy.log` |

## 7. 三句话交接
1. 一切官方注入在**请求侧**就地隔离替换为道经，**仍上行 AWS Q**，**绝不路由第三方模型**。
2. 隔离的命门是"纯道头"：`_getDaoHeader()` / `extension.js` 预览 / `_buildDaoSystemPrompt()` 三者
   必须同为"你本無名…只是遵道而行"，**任一处写回"你是Kiro"都会把身份带回来**。
3. 改完务必 `node --check` + 跑 `verify-isolation.ps1`；删除/隔离类断言一律真打端点取证。
