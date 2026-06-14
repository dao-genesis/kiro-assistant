# Kiro Assistant · Dao Agent

A transparent local proxy extension for [Kiro IDE](https://kiro.dev) that replaces
the official system prompt / identity / tool rules **in-flight** with the silk-text
*Dao De Jing* (帛书《老子》) and the *Yin Fu Jing* (道藏《阴符经》). Traffic still goes
to the **official AWS Q backend only** — never routed to any third-party model.
Cross-platform, zero hardcoding, install once, works everywhere.

> **v1.0.0** — 归一首发 / consolidation baseline (迁移整理 · 去芜存精 · 道生一·得一). Pure source isolation
> (请求侧 system-prompt 全替换 · 响应侧身份净化 · 历史 SP 隔离 · 工具隔离 · 幂等防重注),
> with **mode persistence**, **classified telemetry**, and — critically for users on
> constrained networks — a **VPN-aware relay subprocess** that bypasses the Electron/
> Chromium network stack and **preserves the user's own proxy/VPN settings by default**
> so the official AWS Q backend stays reachable. Per-frame diagnostic disk dumps are now
> **soft-coded off** (`DAO_DEBUG=1` to enable) so streaming never stalls.
> *损之又损，以至于无为 · 无为而无不为 · 水善利万物而有静 · 道法自然。*

## Download

Grab the latest packaged extension from **[Releases](https://github.com/zhouyoukang1234-spec/kiro-assistant/releases)**.

| Extension | What it does | Latest | Download |
| --- | --- | --- | --- |
| **kiro-assistant**（Dao Agent · 反代换示插）| Reverse-proxies Kiro's outbound API; replaces the official system prompt / identity / tool rules with the Dao canon, keeps tools usable, stays on official AWS Q. | `1.0.0` | [Releases](https://github.com/zhouyoukang1234-spec/kiro-assistant/releases) |

> Companion project for Windsurf IDE: **[windsurf-assistant](https://github.com/zhouyoukang1234-spec/windsurf-assistant)** (same isolation philosophy, gRPC/protobuf wire protocol).

## Features

- **Transparent Proxy** — Local HTTP proxy intercepts Kiro's API calls for system prompt injection
- **Source Isolation** — Official system prompt / identity / tool rules are replaced in-flight with the Dao canon; the model never self-identifies as Kiro, yet all real tools stay usable
- **Dual Mode** — `invert` (Dao system-prompt injection + isolation) and `passthrough` (direct connection), **persisted to disk** and restored on restart (disk > env > default)
- **Classified Telemetry** — capture/inject tallies persist across restarts and are broken down by RPC path (`json` / `cbor`), exposed via `/origin/ping`
- **End-to-End Self-Check** — `/origin/verify` endpoint asserts 7 isolation invariants locally **without calling AWS**
- **VPN-Aware Relay** — a detached Node.js subprocess (`_upstream_relay.js`) carries HTTPS to AWS Q outside Electron's hijacked network stack, **inheriting the user's proxy/VPN by default** (auto mode), with auto-restart and graceful direct-mode fallback
- **Model-Preserving** — the user's own selected `modelId` is always forwarded; no model is ever forced (free / region-limited accounts keep working)
- **Soft-Coded Diagnostics** — per-request / per-frame disk dumps are off by default (`DAO_DEBUG=1` to enable), so streaming never stalls and no residue accumulates
- **Cross-Platform** — Auto-detects Kiro settings path on Windows, macOS, and Linux
- **Zero Hardcoding** — No hardcoded paths, ports, AWS regions, or profile ARNs; everything is dynamically discovered
- **Proxy Persistence** — Proxy process survives Kiro restarts (detached process + watchdog)
- **Multi-Account Isolation** — Per-user port assignment via FNV-1a hash (range 11436-11485)
- **Webview Panel** — Real-time proxy status and system prompt editor in the sidebar

## Architecture

```text
Kiro IDE (Electron)
  └─ settings.json: codewhisperer.config.endpoints → http://127.0.0.1:<port>
       └─ kiro-dao-proxy.js (HTTP proxy, runs inside Kiro's Node host)
            ├─ /origin/ping     ← Management endpoint (version, mode, telemetry)
            ├─ /origin/mode     ← Mode switching (persisted to _origin_mode.txt)
            ├─ /origin/verify   ← Self-sufficient isolation self-check (7 asserts)
            ├─ /origin/_quit    ← Graceful shutdown
            ├─ generateAssistantResponse ← deconstruction + SP injection
            │    ├─ SP isolation (_isolateDao strips Kiro regions)
            │    ├─ Workspace / identity / EnvironmentContext stripping
            │    ├─ Kiro-specific tool removal (orphan toolUses cleaned)
            │    ├─ Dao canon prepended (帛书《老子》+《阴符经》)
            │    ├─ user's own modelId preserved (never forces an unavailable model)
            │    └─ CBOR / Smithy EventStream stream-purify
            └─ _upstream_relay.js  ← detached Node.js subprocess (child_process.fork)
                 · bypasses Chromium network-stack hijacking of HTTPS
                 · inherits the user's proxy/VPN env by default (auto mode)
                 · auto-restart on exit; falls back to direct mode if missing
                 └─ → official AWS Q endpoint (region auto-discovered)
```

## Installation

### Method 1: VSIX (Recommended)

1. Download the latest `kiro-assistant-<version>.vsix` from [Releases](https://github.com/zhouyoukang1234-spec/kiro-assistant/releases).
2. In Kiro / VS Code: Command Palette → `Extensions: Install from VSIX...`, pick the file. (Or `kiro --install-extension kiro-assistant-<version>.vsix`.)
3. Restart Kiro → Command Palette → `Kiro Assistant: Start (invert)`.

### Method 2: Direct Install (Windows)

```cmd
install.cmd
:: Restart Kiro
:: Command Palette → "Kiro Assistant: Start (invert)"
```

### Method 3: Manual

1. Copy the entire extension directory to Kiro's built-in extensions folder.
2. Restart Kiro.
3. Command Palette → `Kiro Assistant: Start (invert)`.

## Commands

| Command | Description |
|---------|-------------|
| `Kiro Assistant: Start (invert)` | Start with Dao system-prompt injection + transparent proxy |
| `Kiro Assistant: Start (passthrough)` | Start with direct connection to the official endpoint |
| `Kiro Assistant: Toggle Mode` | Switch between invert and passthrough (persisted to disk) |
| `Kiro Assistant: Preview System Prompt` | Open the injected system prompt in the browser |
| `Kiro Assistant: Self-test (L1 + L2)` | Run L1 + L2 diagnostics |
| `Kiro Assistant: Terminal exec / list / close` | Terminal session pool helpers (DaoTerminalPool) |

> The `/origin/verify` self-check endpoint is still served by the proxy; it is exercised
> by `Self-test (L1 + L2)` rather than a separate command.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `kiro.dao.port` | 0 (auto) | Proxy port. 0 = auto per-user FNV-1a hash (11436-11485). Non-zero overrides. |
| `kiro.dao.defaultMode` | "invert" | Default mode on first activation (overridden by persisted disk value if present) |
| `kiro.dao.banner` | false | Show startup banner |

### Environment variables (软编码 · 为变所适)

All optional — sensible defaults work everywhere. Set them on the Kiro process env.

| Var | Default | Description |
|-----|---------|-------------|
| `DAO_PROXY_MODE` | `auto` | `auto` keeps the user's `HTTP(S)_PROXY`/VPN settings (recommended for constrained networks); `direct` strips proxy env and forces a direct connection; `custom` uses `DAO_PROXY_URL`. |
| `DAO_PROXY_URL` | — | Upstream proxy URL used when `DAO_PROXY_MODE=custom`. |
| `DAO_DEFAULT_MODEL` | (user's selected model) | Fallback model id only for pseudo-models (`simple-task`/`task`); the user's own selected model is always preserved otherwise. |
| `DAO_DEBUG` / `DAO_DEBUG_FRAMES` | off | When `1`, persist per-request / per-frame diagnostic dumps to `vendor/`. Off by default so streaming never stalls and no residue accumulates. |

## File Structure

```text
kiro-assistant/
├── package.json              # VSIX manifest
├── extension.js              # Extension entry point + sidebar webview
├── LICENSE.txt               # Apache-2.0
├── install.cmd               # Universal Windows installer
├── .vscodeignore             # VSIX packaging exclusions
├── .gitignore                # Git exclusions (incl. runtime state files)
├── scripts/
│   ├── deploy-plugin.ps1     # Deploy into Kiro's built-in extensions folder
│   └── verify-isolation.ps1  # Isolation verification helper
├── vendor/
│   ├── kiro-dao-proxy.js     # Proxy core (isolation pipeline + endpoints)
│   ├── _upstream_relay.js    # Detached HTTPS relay subprocess (bypasses Chromium net stack)
│   └── bundled-origin/
│       ├── _silk_dao.txt     # Dao De Jing — Dao section
│       ├── _silk_de.txt      # Dao De Jing — De section
│       └── _yinfu.txt        # Yin Fu Jing
└── media/
    ├── icon.png              # Extension icon
    ├── icon.svg              # Sidebar icon
    └── webview-app.js        # Sidebar webview UI
```

## Build from Source

Requires Node ≥ 18.

```bash
npm run package
# → kiro-assistant-<version>.vsix  (packaged via @vscode/vsce)
```

Runtime state files (`_origin_mode.txt`, `_scripture_mode.txt`, `_dao_stats.json`,
`_dao_isolated_sp.txt`) are generated at runtime and excluded from both git and the VSIX.

## How It Works

1. **Anchoring** — On activation, writes `codewhisperer.config.endpoints` into Kiro's `settings.json`, pointing at the local proxy.
2. **Proxy** — A detached Node.js HTTP proxy process intercepts all Kiro API calls.
3. **Injection** — In `invert` mode, the proxy isolates the official system prompt (strips Kiro identity/tool rules), prepends the Dao canon, then forwards to the real AWS Q endpoint.
4. **Passthrough** — In `passthrough` mode, requests go directly to the official endpoint without modification.
5. **Watchdog** — The extension periodically pings the proxy and respawns it if unresponsive.

## Verification

1. Command Palette → `Kiro Assistant: Start (invert)`, then restart Kiro to load the endpoint config.
2. Command Palette → `Kiro Assistant: Self-test (L1 + L2)` → expect the isolation self-check to **PASS**.
3. Ask the model "who are you?" — it should answer as the Dao (guided by 《老子》/《阴符经》), never self-identifying as Kiro, while tools remain usable.

## License

Apache-2.0 — see [LICENSE.txt](LICENSE.txt).

---

*反者道之动也 · 弱者道之用也 · 损之又损，以至于无为 · 无为而无不为 · 道法自然*
