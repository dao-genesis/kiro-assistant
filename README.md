# Kiro Assistant

A transparent local proxy extension for [Kiro IDE](https://kiro.dev) that provides system prompt injection, cross-platform auto-adaptation, and zero hardcoding. Install once, works everywhere.

> **v12.1.0** — Pure source isolation: official system prompts/identity/tool rules are replaced in-flight with the Dao De Jing & Yin Fu Jing. Traffic still goes to the official AWS Q backend only — **never routed to any third-party model**. Universal cross-platform, zero hardcoding, auto-discovers AWS regions, dynamic anchoring, proxy persists across Kiro restarts.

## Features

- **Transparent Proxy** — Local HTTP proxy intercepts Kiro's API calls for system prompt injection
- **Cross-Platform** — Auto-detects Kiro settings path on Windows, macOS, and Linux
- **Zero Hardcoding** — No hardcoded paths, ports, AWS regions, or profile ARNs. Everything is dynamically discovered
- **Dynamic Region Discovery** — Automatically detects AWS regions from Kiro's requests
- **Proxy Persistence** — Proxy process survives Kiro restarts (detached process + watchdog)
- **Dual Mode** — `invert` (custom system prompt injection) and `passthrough` (direct connection)
- **Multi-Account Isolation** — Per-user port assignment via FNV-1a hash (range 11436-11485)
- **8-Layer Deconstruction** — Comprehensive system prompt processing pipeline
- **Webview Panel** — Real-time proxy status and system prompt editor in sidebar
- **Self-Test** — Built-in L1+L2 diagnostic for quick verification

## Architecture

```text
Kiro IDE
  └─ settings.json: codewhisperer.config.endpoints → http://127.0.0.1:<port>
       └─ kiro-dao-proxy.js (HTTP proxy)
            ├─ /origin/ping    ← Management endpoint
            ├─ /origin/mode    ← Mode switching
            ├─ /origin/_quit   ← Graceful shutdown
            └─ generateAssistantResponse ← 8-layer deconstruction + SP injection
                 ├─ 1/8 SP isolation
                 ├─ 2/8 Workspace directive stripping
                 ├─ 3/8 Assistant identity removal
                 ├─ 4/8 Kiro-specific tool removal
                 ├─ 5/8 EnvironmentContext stripping
                 ├─ 6/8 Identity self-claim removal
                 ├─ 7/8 Header sanitization
                 └─ 8/8 CBOR streaming passthrough
```

## Installation

### Method 1: Direct Install (Recommended for Windows)

```cmd
install.cmd
:: Restart Kiro
:: Command Palette → "Kiro Assistant: Start"
```

### Method 2: VSIX Package

```powershell
npm run package
:: Then install in Kiro: kiro --install-extension kiro-assistant-12.1.0.vsix
```

### Method 3: Manual

1. Copy the entire extension directory to Kiro's built-in extensions folder
2. Restart Kiro
3. Command Palette → `Kiro Assistant: Start (invert)`

## Commands

| Command | Description |
|---------|-------------|
| `Kiro Assistant: Start (invert)` | Start with system prompt injection + transparent proxy |
| `Kiro Assistant: Start (passthrough)` | Start with direct connection to official endpoint |
| `Kiro Assistant: Toggle Mode` | Switch between invert and passthrough |
| `Kiro Assistant: Preview System Prompt` | Open system prompt in browser |
| `Kiro Assistant: Self-test` | Run L1 + L2 diagnostics |
| `Kiro Assistant: Terminal exec` | Execute command in terminal session pool |
| `Kiro Assistant: Terminal list` | List terminal sessions |
| `Kiro Assistant: Terminal close` | Close terminal session |

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `kiro.dao.port` | 0 (auto) | Proxy port. 0 = auto per-user FNV-1a hash (11436-11485). Non-zero overrides. |
| `kiro.dao.defaultMode` | "invert" | Default mode on first activation |
| `kiro.dao.banner` | false | Show startup banner |

## File Structure

```text
kiro-assistant/
├── package.json              # VSIX manifest
├── extension.js              # Extension entry point
├── LICENSE.txt               # Apache-2.0
├── install.cmd               # Universal Windows installer
├── .vscodeignore             # VSIX packaging exclusions
├── .gitignore                # Git exclusions
├── vendor/
│   ├── kiro-dao-proxy.js     # Proxy core (8-layer deconstruction)
│   └── bundled-origin/
│       ├── _silk_dao.txt     # Dao De Jing — Dao section
│       ├── _silk_de.txt      # Dao De Jing — De section
│       └── _yinfu.txt        # Yin Fu Jing
└── media/
    ├── icon.png              # Extension icon
    ├── icon.svg              # Sidebar icon
    └── webview-app.js        # Sidebar webview UI
```

## Verification

1. Start proxy: Command Palette → `Kiro Assistant: Start (invert)`
2. Restart Kiro (to load endpoints configuration)
3. Self-test: Command Palette → `Kiro Assistant: Self-test`
4. Send a message, check Output → "Kiro Assistant" channel
5. Confirm: model should not self-identify as Kiro (deconstruction active)

## How It Works

1. **Anchoring**: On activation, writes `codewhisperer.config.endpoints` to Kiro's `settings.json`, pointing to the local proxy
2. **Proxy**: A detached Node.js HTTP proxy process intercepts all Kiro API calls
3. **Injection**: In `invert` mode, the proxy processes requests through the 8-layer deconstruction pipeline before forwarding to the real AWS Q endpoint
4. **Passthrough**: In `passthrough` mode, requests go directly to the official endpoint without modification
5. **Watchdog**: Every 60s, the extension pings the proxy. If unresponsive, it respawns automatically

## Related Projects

- [windsurf-assistant](https://github.com/zhouyoukang/windsurf-assistant) — The companion project for Windsurf IDE

## License

Apache-2.0 — See [LICENSE.txt](LICENSE.txt)
