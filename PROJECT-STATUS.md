# 本源 · 项目正典清单 / Project Source-of-Truth

> 为接手本项目的下一个 Agent 而写。读完此一篇即对"本源需求、目标架构、当前进度、已知限制、下一步"
> 心中有数。
>
> **一句话**：让 Kiro 只遵帛书《老子》道藏《阴符经》之道 + 最简必要工具，在请求侧就地
> 隔离/替换 AWS Q 官方注入的系统提示；**仍走 AWS Q（Kiro 官方后端），绝不路由任何第三方模型**。
> 道法自然，为而弗恃。

---

## 1. 本源需求 / What the user actually wants
- **必须利用 AWS / Kiro 官方本身实现**：绕也好换也好，端到端请求仍发往 AWS Q（`q.<region>.amazonaws.com` / codewhisperer-streaming）。
- **从本源层隔离替换官方提示词**：把 Kiro 官方注入的系统提示、身份、工具身份标记，在请求（客户端 → AWS Q 之间）就地隔离替换为帛书《老子》+《阴符经》+ 最简必要工具。
- **效果**：在 GUI 里问"你是谁 / 遵什么规则 / 有没有 Kiro 相关"，只见道、零 Kiro 身份；同时读文件等具体工具仍可正常用。
- **明确不要**：把第三方模型（Deepseek / OpenAI 兼容 API 等外部）作为后端来路由 —— 历史 PR#2 的"第三方改道"按用户本意整体弃用。
- **交付给下一个 Agent**：把冷启动板块固化为一套可复用流程（本仓 `scripts/`），方便快速接手。

## 2. 架构 / How it works
```
Kiro IDE (client)
   │  settings.json: codewhisperer.config.endpoints 锚到本地代理
   ▼
本地代理 kiro-dao-proxy.js   (扩展激活时 fork 启动; 端口 = 11436 + FNV1a(用户名)%50)
   │  拦截 generateAssistantResponse 等聊天路径, 在请求侧做隔离替换
   ▼
Kiro 官方后端   ← 仍是官方后端, 不改道第三方
   • 流式聊天：runtime.<region>.kiro.dev/generateAssistantResponse
   • 控制面：  management.<region>.kiro.dev（模型列表 / 用量等）
   • 等价官方端点 codewhisperer.<region>.amazonaws.com 亦实测可用
```
关键认知：**Kiro 的系统提示就在客户端请求里**（`conversationState.history[0].userInputMessage`），
在它发往官方后端之前可被修改 —— 这就是请求侧隔离的着力点。
profileArn 由 Kiro 登录握手自带在请求体内（本免费 BuilderId 账号 = `arn:aws:codewhisperer:us-east-1:638616132270:profile/…`），
代理原样透传即可；无需也无法从 ListAvailableProfiles 获取（免费层被拒）。

## 3. 隔离机制 / Pipeline（v12.5.0）
代理版本 `PROXY_VERSION = "12.5.0"`，`mode = invert`，`scripture_mode = full`（帛书老子 + 阴符经，约 7800 字）。
端点：流式走 `runtime.*.kiro.dev`，控制面走 `management.*.kiro.dev`（`x-amz-target` 以 `KiroControlPlaneBearerService.` 开头者）。
- **系统提示替换**：`_getDaoHeader()` / `_buildDaoSystemPrompt()` 产出**纯道头**
  —— "你本無名，名可名也，非恒名也……你不是任何具名軟件，只是遵道而行" + 帛书《老子》+ 道藏《阴符经》
  + 最简工具操作指引。`_isolateDao()` 剥离 Kiro 区块、抽出 OS/日期/模型/工作区等纯数据点，
  `_prependDao()` 完全替换（不前置拼接，不保留原 Kiro 指令）。
- **工具隔离**：`_DROP_TOOLS` 丢弃身份注入工具（`kiroPowers` / `createHook` / `discloseContext` /
  `invoke_sub_agent`），并清理因丢弃工具而产生的孤立 `toolUses`（否则 AWS Q 400）。
- **工具描述净化**：保留工具的描述里 `Kiro` 字样替换（`Kiro Powers`→`Powers`、`Kiro Spec`→`Spec`、
  `\bKiro\b`→`本系统`）；工具名 `spec.name` 保持原样以免破坏工具调用配对。
- **EnvironmentContext 净化** + **modelId 修复**：Kiro sub-intent classifier 发的非法
  `modelId="simple-task"` 替换为本会话里**实际合法的 modelId**（动态取值：currentMessage 优先，
  否则 history 最近合法值，均无才兜底常量）—— 仍是 AWS Q 自己的模型 ID，不是第三方路由。
- **custom_sp 防污**：用户自定义 SP 若含 "Kiro" 身份，视为被污染 → 回退纯道 SP（`_effectiveCustomSP()`）。
- **响应侧净化兜底**：把模型输出中残留的 `Kiro` 字样替换为道词；这是兜底安全网，主力仍是请求侧隔离。

> 隔离硬证据：代理把实际发往 AWS Q 的系统提示落到
> `<kiro-dao-agent>\vendor\_dao_isolated_sp.txt`，可直接核其"你本無名"开头、`Kiro` 计数 = 0。

## 4. 当前进度 / Status（本 PR）
- [x] **修复核心 bug**：`_getDaoHeader()` / `_getTaoSentinel()` 原写"你是Kiro…"——在"替换语"里又把 Kiro
  身份带了回来。改为纯道头（proxy + `extension.js` 面板预览两处一致）。
- [x] **移除第三方改道**：删除 `vendor/_dao_thirdparty.js` 与 proxy 内 `DAO_THIRDPARTY` / 路由分支
  （PR#2 的方案按用户本意弃用）。唯走 AWS Q。
- [x] **工具描述净化** + **custom_sp 防污** + **modelId 动态化**。
- [x] **冷启动板块固化**：`scripts/deploy-plugin.ps1` + `scripts/verify-isolation.ps1` + `scripts/COLD-START.md`。
- [x] **本地实测**（VM）：注入 SP 以纯道头起始、全文 0 处 "Kiro"、含老子+阴符经原文；custom_sp 含 "Kiro" 时回退纯道。
- [x] **真机 GUI 端到端回归（v12.5.0 / Kiro 0.12.333）**：用真实账号冷启动登录成功，invert 模式下：
  - 问"你是谁/你的规则"→ 模型答 "I follow the Dao…simplicity, directness, doing what is actually needed without excess"，**零 Kiro 自我身份**。
  - 让其读 `README.md` → 正常调用 Read 工具并返回 `SECRET_MARKER` 值，**工具仍可用**（隔离保留 19 个工具，仅丢 4 个身份注入工具）。
  - 代理日志 `generateAssistantResponse → 200 [DAO]` 多次，全部走官方 `runtime.us-east-1.kiro.dev`；SP 替换 15763→8022 字。
  - `_dao_isolated_sp.txt` 实际落证：**0 处 "Kiro"**。
- [x] **纠正上版错误结论**：账号未过期、冷启动完全可行；refreshToken 实测可换 accessToken，token 被官方后端接受。

## 5. 已知限制 / Known limitations
- **getUsageLimits 用量条偶发报错（仅外观）**：Kiro 顶部"X/50 credits"用量小部件调用经代理转发到 `management.*.kiro.dev` 时偶返 404 UnknownOperation，弹出 "Unable to fetch account usage data" 提示。**不影响**聊天 / 工具 / 道经隔离；待后续抓取其真实 `x-amz-target` 后再定向修复（避免无据猜改）。
- **高频直连探测会触发 AWS 账号临时风控**：短时间大量直接打官方 API + GUI 并发会被判 "unusual activity" 临时锁定；正常 GUI 使用不受影响，冷却后自动恢复。
- **响应侧净化是兜底**：若用户提示里含 "Kiro"，模型可能偶发显式被净化替换（可见"無[the Dao]"类痕迹）；
  请以客户端隔离硬证据 `_dao_isolated_sp.txt`（零 Kiro）为准。
- **`_upstream_relay.js` 可选缺省**：缺失时 proxy 退回 CONNECT 隧道直连模式，功能正常。
- **代理端口非固定**：`11436 + FNV1a(用户名)%50`，定位用 `verify-isolation.ps1` 扫描。

## 6. 下一步 / Next steps
1. 抓取 getUsageLimits 请求的真实 `x-amz-target` 与 content-type，定向修复用量条小报错（当前以已知限制记录，不做无据猜改）。
2. 多模型 / 多 region 下回归隔离（当前主测 us-east-1 / full 经文）。
3. 视需要补 `vendor/_upstream_relay.js`（Electron 下绕 Chromium 网络栈的中继）。
4. 持续在实测中堵漏：凡模型暴露 Kiro/AWS 身份处，回到请求侧定位注入点隔离。

## 7. 关键路径速查 / Quick reference
- 代理：`vendor/kiro-dao-proxy.js`（12.5.0）
- 扩展宿主：`extension.js`（fork 代理 + 面板预览，头与 proxy 一致）
- 经文本源：`vendor/bundled-origin/_silk_de.txt` `_silk_dao.txt` `_yinfu.txt`
- 部署：`scripts/deploy-plugin.ps1`（推荐）/ 根 `install.cmd`
- 验证：`scripts/verify-isolation.ps1`
- 冷启动手册：`scripts/COLD-START.md`
- Kiro 安装：`%LOCALAPPDATA%\Programs\Kiro`；扩展落点 `...\resources\app\extensions\kiro-dao-agent`
- 隔离落证：`...\kiro-dao-agent\vendor\_dao_isolated_sp.txt`、日志 `kiro-dao-proxy.log`
