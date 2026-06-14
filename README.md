# Kiro Assistant · 道法自然（Dao Agent）

> 让你的 **Kiro IDE** 彻底变好用 —— 在通道中把官方系统提示词 / 身份 / 工具规则，**就地无声替换**为帛书《老子》与道藏《阴符经》之道魂。流量仍只走**官方 AWS Q 后端**，绝不转发任何第三方模型。跨平台、零硬编码、装一次、处处可用。

## 🎬 视频介绍

<div align="center">

[![Kiro+道德经阴符经 让你的Kiro彻底变好用！](media/video-cover.jpg)](https://www.bilibili.com/video/BV1LRV26FEQa)

**▶ [点击封面 / 前往 B 站观看完整视频](https://www.bilibili.com/video/BV1LRV26FEQa)**

**🌐 [打开自动播放主页（GitHub Pages · 进入即自动播放）](https://zhouyoukang1234-spec.github.io/kiro-assistant/)**

</div>

> GitHub 仓库页（本 README）受平台限制无法自动播放视频；上方"自动播放主页"是一个真正的网页，进入即自动播放 B 站视频，点击可跳转 B 站原页观看。

## ⬇️ 下载

前往 **[Releases](https://github.com/zhouyoukang1234-spec/kiro-assistant/releases)** 获取最新打包好的插件（`kiro-assistant-<版本>.vsix`）。

| 插件 | 作用 | 最新版本 | 下载 |
| --- | --- | --- | --- |
| **kiro-assistant**（道 Agent · 反代换示插）| 反向代理 Kiro 出站 API，将官方系统提示词/身份/工具规则替换为道藏经文，工具照常可用，后端仍走官方 AWS Q。 | `1.0.0` | [Releases](https://github.com/zhouyoukang1234-spec/kiro-assistant/releases) |

## 📖 这是什么

Kiro Assistant 是一个**本地透明代理**插件。它在你的电脑本机起一个小代理，悄悄拦截 Kiro 发往云端的请求，在请求里把官方的"身份与规则"换成道魂经文，再原样转发到**官方 AWS Q**。模型从此不再自称 Kiro，而所有真实工具（读写文件、跑命令、终端等）依旧全部可用。

核心理念：**水善利万物而有静，天之道利而不害**。插件只在通道中"借力"，不破坏 Kiro 本体、不强加任何模型、不破坏你正常的网络与使用体验。

## ✨ 核心特性

- **透明代理**：本机 HTTP 代理拦截 Kiro 的 API 调用，就地注入系统提示词。
- **源头隔离**：请求侧系统提示词全替换 + 响应侧身份净化 + 历史 SP 隔离 + 工具隔离 + 幂等防重注；模型不自称 Kiro，工具却照常可用。
- **双模式**：`invert`（注入道魂 + 隔离）与 `passthrough`（直连官方），**落盘持久化**，重启自动恢复。
- **VPN 友好**：分离出的 `_upstream_relay.js` 子进程在 Electron 被劫持的网络栈之外承载 HTTPS，**默认继承你自己的代理/VPN**（auto 模式），失败自动回退直连。国内受限网络也能稳定连上官方后端。
- **模型保全**：永远转发你自己选择的 `modelId`，从不强制切换；免费账号 / 区域受限账号照常工作。
- **软编码 · 为变所适**：无硬编码路径/端口/区域/ARN，全部动态发现；诊断转储默认关闭（`DAO_DEBUG=1` 开启），流式永不卡顿、无残渣堆积。
- **跨平台**：自动识别 Windows / macOS / Linux 上的 Kiro 配置路径。
- **代理常驻**：代理以独立进程运行，Kiro 重启不灭，watchdog 自愈。

## 🚀 安装

**方式一 · VSIX（推荐）**
1. 从 [Releases](https://github.com/zhouyoukang1234-spec/kiro-assistant/releases) 下载最新 `kiro-assistant-<版本>.vsix`。
2. Kiro / VS Code：命令面板 → `Extensions: Install from VSIX...`，选中文件。
3. 重启 Kiro → 命令面板 → `Kiro Assistant: Start (invert)`。

**方式二 · Windows 一键**
```cmd
install.cmd
:: 重启 Kiro → 命令面板 → "Kiro Assistant: Start (invert)"
```

## ✅ 验证是否生效

命令面板 → `Kiro Assistant: Self-test (L1 + L2)`，隔离自检应为 **PASS**；或访问代理 `/origin/ping` 查看 `version` / `mode` / `proxy_mode`。

---

> 损之又损，以至于无为 · 无为而无不为 · 水善利万物而有静 · **道法自然**。
>
> 同门项目（Windsurf IDE）：**[windsurf-assistant](https://github.com/zhouyoukang1234-spec/windsurf-assistant)**。
