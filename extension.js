// extension.js · kiro-dao-agent v11.0.0 · 太上不知有之 · 无为而无以为
//
// 道德经 · 第十七章: "太上, 不知有之; 其次, 亲而誉之"
// 道德经 · 第十七章: "功成事遂, 百姓皆谓我自然"
// 道德经 · 第十一章: "三十辐同一毂, 当其无有, 车之用也"
//
// v11: 太上不知有之 · 代理独立于Kiro进程 · 重启不灭 · 无为而治
//   根本修复: proxy 以 detached child process 运行, 不随 Kiro 重启而亡
//   extension 仅做管理: 启/停/观照 · proxy 自立自化
//
// Kiro vs Windsurf 架构差异:
//   Windsurf: spawn hook → LS进程参数重写 → proxy(source.js)
//   Kiro: settings.json codewhisperer.config.endpoints → 直接指向proxy
//   故: 无需spawn hook, 无需LS重启, 仅写settings.json锚定
//
// 功能映射 (dao-proxy-min → kiro-dao-agent v11):
//   ✅ proxy启动/停止 (detached child process · 不随Kiro亡)
//   ✅ settings.json锚定 (codewhisperer.config.endpoints · 立即写入)
//   ✅ invert/passthrough模式切换
//   ✅ /origin/管理端点 (ping/mode/quit/canon/sig/custom_sp/prompts/scripture-mode)
//   ✅ 终端会话池 (DaoTerminalPool)
//   ✅ 命令面板命令
//   ✅ watchdog自愈 (15s · 代理亡即复生)
//   ✅ SSE客户端 (DaoSseClient · 实时推送SP/模式变化)
//   ✅ Custom SP编辑 (webview textarea + 保存/载入/归道)
//   ✅ 经藏切换 (laozi/yinfu/full · proxy /origin/canon)
//   ❌ spawn hook (Kiro无LS进程, 不需要)
//   ❌ 外接api (暂不移植, 道法自然, 损之又损)

"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const cp = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const PKG_VERSION = "12.6.0";
const DEFAULT_PORT = 11436;

// ═══════════════════════════ DAO Quotes ═══════════════════════════
const DAO_QUOTES = [
  "道可道，非常道",
  "上善若水",
  "大音希声，大象无形",
  "道法自然",
  "无为而无不为",
  "致虚极，守静笃",
  "反者道之动",
  "知者不言，言者不知",
  "天下莫柔弱于水",
  "为学日益，为道日损",
];

// ═══════════════════════════ 缓存 ═══════════════════════════
let _cachedPort = DEFAULT_PORT;
let _cachedProxyUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
let _cachedAnchored = false;
let _cachedMode = "invert";
let _activateTs = 0;
let _proxyChild = null; // detached child process · 不随Kiro亡
let _proxyChildPid = 0; // 记录PID · 用于检查存活

// ═══════════════════════════ 日志 ═══════════════════════════
let _channel = null;
function logger() {
  if (!_channel) _channel = vscode.window.createOutputChannel("道Agent");
  return _channel;
}
function _stamp() {
  const d = new Date(),
    p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const L = {
  info: (tag, msg) =>
    logger().appendLine(`[${_stamp()}] [INFO] [${tag}] ${msg}`),
  warn: (tag, msg) =>
    logger().appendLine(`[${_stamp()}] [WARN] [${tag}] ${msg}`),
  error: (tag, msg) =>
    logger().appendLine(`[${_stamp()}] [ERR]  [${tag}] ${msg}`),
};

// ═══════════════════════════ per-user 端口 FNV-1a ═══════════════════════════
function fnv1aPort(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return 11436 + (h % 50); // 11436..11485
}

function resolvePort() {
  const c = vscode.workspace.getConfiguration("kiro.dao");
  const explicit = parseInt(c.get("port"), 10);
  if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 65535)
    return explicit;
  try {
    return fnv1aPort(os.userInfo().username);
  } catch {
    return DEFAULT_PORT;
  }
}

function cfg() {
  _cachedPort = resolvePort();
  _cachedProxyUrl = `http://127.0.0.1:${_cachedPort}`;
  return { port: _cachedPort };
}

// ═══════════════════════════ settings.json 路径 · v12跨平台 ═══════════════════════════
function _settingsJsonPath() {
  // v12: 跨平台自动检测 — Windows/macOS/Linux
  if (process.env.KIRO_SETTINGS_PATH) return process.env.KIRO_SETTINGS_PATH;
  const plat = process.platform;
  const home = os.homedir();
  if (plat === "win32") {
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Kiro", "User", "settings.json");
  }
  if (plat === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Kiro",
      "User",
      "settings.json",
    );
  }
  // Linux
  return path.join(home, ".config", "Kiro", "User", "settings.json");
}

function _readSettingsJson(sp) {
  try {
    return JSON.parse(fs.readFileSync(sp, "utf8"));
  } catch {
    return null;
  }
}

function _writeSettingsJson(sp, json) {
  try {
    fs.writeFileSync(sp, JSON.stringify(json, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════ 锚定 · codewhisperer.config.endpoints ═══════════════════════════
// Kiro 用 codewhisperer.config.endpoints (非 Windsurf 的 codeium.apiServerUrl)
// 写入 [{region, endpoint}] 将 API 请求重定向到本地代理

function isAnchored() {
  const sp = _settingsJsonPath();
  const json = _readSettingsJson(sp);
  if (!json) return false;
  const eps = json["codewhisperer.config.endpoints"];
  return Array.isArray(eps) && eps.some((e) => e.endpoint === _cachedProxyUrl);
}

async function setAnchor(port) {
  const url = `http://127.0.0.1:${port}`;
  const sp = _settingsJsonPath();
  let needWrite = false;
  try {
    const json = _readSettingsJson(sp);
    if (json) {
      // v12: 动态region — 从proxy获取已知region, 默认us-east-1+eu-central-1
      let regions = ["us-east-1", "eu-central-1"];
      try {
        const ping = await proxyIsAlive(port);
        if (ping && ping.regions) regions = ping.regions;
      } catch {}
      const endpoints = regions.map((r) => ({ region: r, endpoint: url }));
      const current = json["codewhisperer.config.endpoints"];
      needWrite =
        !current ||
        current.length !== endpoints.length ||
        current.some((e, i) => e.endpoint !== endpoints[i].endpoint);
      if (needWrite) {
        json["codewhisperer.config.endpoints"] = endpoints;
        if (_writeSettingsJson(sp, json)) {
          L.info("anchor", `file set ${url} → ${sp}`);
        }
      } else {
        L.info("anchor", `already ${url} · skip write (无为而治)`);
      }
    } else {
      L.warn("anchor", `settings.json unreadable: ${sp}`);
    }
  } catch (e) {
    L.warn("anchor", `file set fail: ${e.message}`);
  }
  _cachedAnchored = true;
  _cachedProxyUrl = url;
}

async function clearAnchor() {
  const sp = _settingsJsonPath();
  const json = _readSettingsJson(sp);
  if (json) {
    delete json["codewhisperer.config.endpoints"];
    _writeSettingsJson(sp, json);
    L.info("anchor", `file cleared → ${sp}`);
  }
  _cachedAnchored = false;
  L.info("anchor", "cleared → Kiro defaults");
}

function _clearAnchorFileSync() {
  const sp = _settingsJsonPath();
  const json = _readSettingsJson(sp);
  if (json) {
    delete json["codewhisperer.config.endpoints"];
    _writeSettingsJson(sp, json);
  }
  _cachedAnchored = false;
}

// ═══════════════════════════ HTTP helpers ═══════════════════════════
function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function httpPostJson(url, body, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

function httpDelete(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "DELETE",
        timeout: timeoutMs,
      };
      const req = http.request(opts, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch {
      resolve(null);
    }
  });
}

// ═══════════════════════════ SSE 客户端 ═══════════════════════════
class DaoSseClient extends EventEmitter {
  constructor(port) {
    super();
    this._port = port || DEFAULT_PORT;
    this._req = null;
    this._res = null;
    this._reconnectTimer = null;
    this._backoffMs = 1000;
    this._stopped = false;
    this._connected = false;
    this._buf = "";
  }
  setPort(p) {
    if (p && p !== this._port) {
      this._port = p;
      this._close();
      if (!this._stopped) this._scheduleReconnect(100);
    }
  }
  isConnected() {
    return this._connected;
  }
  start() {
    this._stopped = false;
    this._connect();
  }
  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._close();
    this.removeAllListeners();
  }
  _close() {
    this._connected = false;
    try {
      if (this._req) this._req.destroy();
    } catch {}
    this._req = null;
    this._res = null;
    this._buf = "";
  }
  _scheduleReconnect(ms) {
    if (this._stopped) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(
      () => {
        this._reconnectTimer = null;
        this._connect();
      },
      ms != null ? ms : this._backoffMs,
    );
    this._backoffMs = Math.min(30000, Math.max(1000, this._backoffMs * 2));
  }
  _connect() {
    if (this._stopped || this._req) return;
    try {
      this._req = http.get(
        `http://127.0.0.1:${this._port}/origin/stream?replay=1`,
        {
          headers: { accept: "text/event-stream", "cache-control": "no-cache" },
          agent: false,
          timeout: 5000,
        },
        (res) => {
          this._res = res;
          if (res.statusCode !== 200) {
            res.resume();
            this._close();
            this._scheduleReconnect();
            return;
          }
          this._connected = true;
          this._backoffMs = 1000;
          try {
            if (res.socket && res.socket.setTimeout) res.socket.setTimeout(0);
          } catch {}
          try {
            this.emit("connect", { port: this._port });
          } catch {}
          res.setEncoding("utf8");
          res.on("data", (chunk) => this._onData(chunk));
          res.on("end", () => {
            this._close();
            if (!this._stopped) this._scheduleReconnect();
          });
          res.on("error", () => {
            this._close();
            if (!this._stopped) this._scheduleReconnect();
          });
        },
      );
      this._req.on("error", () => {
        this._close();
        if (!this._stopped) this._scheduleReconnect();
      });
      this._req.on("timeout", () => {
        try {
          this._req && this._req.destroy();
        } catch {}
      });
    } catch {
      this._close();
      if (!this._stopped) this._scheduleReconnect();
    }
  }
  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf("\n\n")) >= 0) {
      const raw = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 2);
      this._dispatch(raw);
    }
  }
  _dispatch(raw) {
    let eventType = "message";
    const dataLines = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const dataStr = dataLines.join("\n");
    let data = dataStr;
    try {
      data = JSON.parse(dataStr);
    } catch {}
    try {
      this.emit(eventType, data);
      this.emit("event", { type: eventType, data });
    } catch {}
  }
}

// ═══════════════════════════ 数据采集 ═══════════════════════════
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
}

async function gatherEssence(port) {
  if (!port)
    return { ts: new Date().toISOString(), proxy: null, proxyUp: false };
  const base = `http://127.0.0.1:${port}`;
  const ping = await withTimeout(
    httpGetJson(`${base}/origin/ping`, 1500),
    2500,
  );
  if (!ping)
    return { ts: new Date().toISOString(), proxy: null, proxyUp: false };
  const [proxy, allInjects] = (await withTimeout(
    Promise.all([
      httpGetJson(`${base}/origin/preview`, 4000),
      httpGetJson(`${base}/origin/allinjects`, 4000),
    ]),
    6000,
  )) || [null, null];
  const diag = {
    proxy_up: true,
    proxy_capturing: !!(proxy && proxy.has_captured_before),
    has_main: proxy ? !!proxy.has_main : false,
    aux_count: proxy ? proxy.aux_count || 0 : 0,
    mode: ping.mode,
    uptime_s: ping.uptime_s,
  };
  return {
    ts: new Date().toISOString(),
    proxy,
    allInjects,
    proxyUp: true,
    diag,
    ping,
  };
}

function getModeLabel() {
  const mode = proxyGetMode();
  return mode === "invert" ? `道Agent · :${_cachedPort}` : `官方Agent · 直连`;
}

// ═══════════════════════════ proxy 启停 · v11 detached process ═══════════════════════════
// v11: 太上不知有之 · proxy 以 detached child process 运行
//   - 不随 Kiro 重启而亡 · settings.json 锚定永存
//   - extension 仅做管理: 启/观/切 · 不做 proxy 生命周期主人
//   - watchdog 15s 自检 · 代理亡即复生

function findProxyJs() {
  // 1. vendor/kiro-dao-proxy.js (VSIX开发时)
  const d1 = path.join(__dirname, "vendor", "kiro-dao-proxy.js");
  try {
    if (fs.statSync(d1).isFile()) return d1;
  } catch {}
  // 2. kiro-dao-proxy.js 同目录 (VSIX安装后flat结构)
  const d2 = path.join(__dirname, "kiro-dao-proxy.js");
  try {
    if (fs.statSync(d2).isFile()) return d2;
  } catch {}
  // 3. 上级目录 (require缓存路径差异)
  const d3 = path.join(path.dirname(__dirname), "kiro-dao-proxy.js");
  try {
    if (fs.statSync(d3).isFile()) return d3;
  } catch {}
  return null;
}

// 检查代理是否存活 (HTTP ping)
async function proxyIsAlive(port) {
  const ping = await httpGetJson(`http://127.0.0.1:${port}/origin/ping`, 2000);
  return ping &&
    ping.ok &&
    (ping.mode === "invert" || ping.mode === "passthrough")
    ? ping
    : null;
}

// v11: 以 detached child process 启动 proxy · 不随 Kiro 亡
function spawnProxy(port, mode) {
  const proxyPath = findProxyJs();
  if (!proxyPath) {
    L.error("proxy", `kiro-dao-proxy.js 不存在: ${__dirname}`);
    return false;
  }
  const isWin = process.platform === "win32";
  const nodeExe = process.execPath || "node";
  const args = [proxyPath];
  const env = {
    ...process.env,
    DAO_PORT: String(port),
    DAO_MODE: mode || "invert",
    // v12.1: 不再清除代理环境变量 · 保留用户VPN(Clash/V2Ray等)
    // proxy内部用 _DIRECT_AGENT (https.Agent) 直连AWS Q · 不读HTTP_PROXY
    // 道义: 五十八章「方而不割，廉而不刿」— 不割用户环境
  };
  try {
    const child = cp.spawn(nodeExe, args, {
      cwd: path.dirname(proxyPath),
      env,
      detached: true,
      stdio: "ignore", // 完全脱开 · 不等IO
      windowsHide: true,
    });
    child.unref(); // 父进程不等待子进程
    _proxyChild = child;
    _proxyChildPid = child.pid || 0;
    L.info(
      "proxy",
      `spawned detached pid=${child.pid} :${port} mode=${mode} src=${proxyPath}`,
    );
    return true;
  } catch (e) {
    L.error("proxy", `spawn fail: ${e.message}`);
    _proxyChild = null;
    _proxyChildPid = 0;
    return false;
  }
}

// v11: 确保代理运行 · 不在则启 · 在则用
async function proxyEnsure(port, mode) {
  // 1. 先检查是否已有代理在运行
  const ping = await proxyIsAlive(port);
  if (ping) {
    _cachedMode = ping.mode || mode || "invert";
    L.info(
      "proxy",
      `already alive :${port} mode=${ping.mode} (pid=${ping.pid || "?"})`,
    );
    return true;
  }
  // 2. 不在则启
  L.info("proxy", `not alive :${port} → spawning...`);
  const ok = spawnProxy(port, mode || "invert");
  if (!ok) return false;
  // 3. 等待代理就绪 (最多30s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const p = await proxyIsAlive(port);
    if (p) {
      _cachedMode = p.mode || mode || "invert";
      L.info(
        "proxy",
        `spawned and alive :${port} mode=${p.mode} (waited ${i + 1}s)`,
      );
      return true;
    }
  }
  L.warn("proxy", `spawned but not responding after 30s :${port}`);
  return false;
}

function proxySetMode(m) {
  _cachedMode = m;
  httpPostJson(
    `http://127.0.0.1:${_cachedPort}/origin/mode`,
    { mode: m },
    2000,
  ).catch(() => {});
}

function proxyGetMode() {
  return _cachedMode;
}

// v11: 停止代理 (仅用于用户主动切换到 passthrough 且想彻底停代理)
// 默认 deactivate 不停代理 · 太上不知有之
async function proxyStop() {
  if (_proxyChild && _proxyChildPid) {
    try {
      process.kill(_proxyChildPid);
    } catch {}
    _proxyChild = null;
    _proxyChildPid = 0;
  }
  // 也尝试通过API让代理自行退出
  await httpPostJson(
    `http://127.0.0.1:${_cachedPort}/origin/_quit`,
    { reason: "user stop" },
    2000,
  ).catch(() => {});
  L.info("proxy", "stopped");
}

// ═══════════════════════════ 终端会话池 ═══════════════════════════
const _T_RS = "\u001E";
const _T_DEFAULT_TIMEOUT = 120000;
const _T_IDLE_TTL_MS = 30 * 60 * 1000;
const _T_GC_INTERVAL_MS = 60_000;
const _T_MAX_BUF_BYTES = 4 * 1024 * 1024;

const _origSpawn = cp.spawn;

class DaoTerminalPool {
  constructor(opts = {}) {
    this.sessions = new Map();
    this.idleTtlMs = opts.idleTtlMs || _T_IDLE_TTL_MS;
    this.gcIntervalMs = opts.gcIntervalMs || _T_GC_INTERVAL_MS;
    this.maxBufBytes = opts.maxBufBytes || _T_MAX_BUF_BYTES;
    this._gcTimer = null;
    this._closed = false;
  }
  _spawnShell(sid) {
    const isWin = process.platform === "win32";
    let shell, args;
    if (isWin) {
      shell = process.env.ComSpec || "cmd.exe";
      args = ["/q", "/k", "@echo off & prompt $G"];
    } else {
      shell = process.env.SHELL || "/bin/bash";
      args = ["--norc", "--noprofile"];
    }
    const env = {
      ...process.env,
      DAO_AGENT_SID: sid,
      PROMPT: "$G ",
      PS1: "$ ",
      PS2: "",
      TERM: "dumb",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CLICOLOR: "0",
    };
    const cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
    return _origSpawn.call(cp, shell, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  _ensure(sid) {
    let s = this.sessions.get(sid);
    if (s && !s.closed) return s;
    const child = this._spawnShell(sid);
    s = {
      child,
      buf: "",
      errBuf: "",
      pending: null,
      closed: false,
      lastUsed: Date.now(),
      sid,
    };
    child.stdout.on("data", (d) => {
      s.buf += d.toString("utf8");
      if (s.buf.length > this.maxBufBytes)
        s.buf = s.buf.slice(-this.maxBufBytes);
      s.lastUsed = Date.now();
      this._tryComplete(sid);
    });
    child.stderr.on("data", (d) => {
      s.errBuf += d.toString("utf8");
      if (s.errBuf.length > this.maxBufBytes)
        s.errBuf = s.errBuf.slice(-this.maxBufBytes);
    });
    child.on("exit", () => {
      s.closed = true;
      if (s.pending) {
        clearTimeout(s.pending.timer);
        s.pending.reject(new Error(`shell 退 sid=${sid}`));
        s.pending = null;
      }
    });
    child.on("error", (e) => {
      s.closed = true;
      if (s.pending) {
        clearTimeout(s.pending.timer);
        s.pending.reject(new Error(`shell 错 sid=${sid}: ${e.message}`));
        s.pending = null;
      }
    });
    this.sessions.set(sid, s);
    return s;
  }
  exec(sid, cmd, opts = {}) {
    if (this._closed) return Promise.reject(new Error("pool closed"));
    if (typeof sid !== "string" || !sid)
      return Promise.reject(new Error("session_id 必填"));
    if (typeof cmd !== "string" || !cmd)
      return Promise.reject(new Error("cmd 必填"));
    const s = this._ensure(sid);
    if (s.pending) return Promise.reject(new Error(`session ${sid} 忙`));
    const eid = crypto.randomUUID();
    const BEG = `${_T_RS}DAO_BEG_${eid}${_T_RS}`;
    const END = `${_T_RS}DAO_END_${eid}${_T_RS}`;
    const isWin = process.platform === "win32";
    const timeout = opts.timeout || _T_DEFAULT_TIMEOUT;
    let wrapped;
    if (isWin) {
      const cdPart = opts.cwd ? `cd /d "${opts.cwd}" & ` : "";
      // cmd /c 包裹: exit只退出子cmd, 不杀持久shell
      // 保存ERRORLEVEL到变量, 因后续命令会覆盖它
      wrapped = `echo ${BEG}\r\nver >nul\r\n${cdPart}cmd /c "${cmd.replace(/"/g, '""')}"\r\nset DAO_EL=%ERRORLEVEL%\r\ncall echo ${END}EXIT=%DAO_EL%\r\n`;
    } else {
      const cdPart = opts.cwd ? `cd "${opts.cwd}" && ` : "";
      const begLit = BEG.replace(/'/g, "'\\''");
      const endLit = END.replace(/'/g, "'\\''");
      wrapped = `printf '%s\\n' '${begLit}'\n{ ${cdPart}${cmd} ; }\nprintf '%sEXIT=%d\\n' '${endLit}' "$?"\n`;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (s.pending && s.pending.eid === eid) {
          s.pending = null;
          reject(new Error(`exec timeout ${timeout}ms sid=${sid}`));
        }
      }, timeout);
      s.pending = {
        eid,
        BEG,
        END,
        resolve,
        reject,
        timer,
        started: Date.now(),
      };
      try {
        s.child.stdin.write(wrapped);
      } catch (e) {
        clearTimeout(timer);
        s.pending = null;
        reject(new Error(`stdin 写失 sid=${sid}: ${e.message}`));
      }
    });
  }
  _tryComplete(sid) {
    const s = this.sessions.get(sid);
    if (!s || !s.pending) return;
    const { BEG, END, resolve, timer, eid } = s.pending;
    const begIdx = s.buf.indexOf(BEG);
    if (begIdx === -1) return;
    const endIdx = s.buf.indexOf(END, begIdx + BEG.length);
    if (endIdx === -1) return;
    const tail = s.buf.slice(endIdx + END.length);
    const m = tail.match(/EXIT=(-?\d+)/);
    if (!m) return;
    const body = s.buf.slice(begIdx + BEG.length, endIdx);
    const exit = parseInt(m[1], 10);
    const afterExit = endIdx + END.length + m.index + m[0].length;
    const nl = s.buf.indexOf("\n", afterExit);
    s.buf = nl >= 0 ? s.buf.slice(nl + 1) : s.buf.slice(afterExit);
    s.pending = null;
    clearTimeout(timer);
    const stderr = s.errBuf;
    s.errBuf = "";
    resolve({
      session_id: sid,
      exec_id: eid,
      stdout: body.replace(/^\s+|\s+$/g, ""),
      stderr: stderr.replace(/^\s+|\s+$/g, ""),
      exit,
    });
  }
  list() {
    return [...this.sessions.entries()].map(([sid, s]) => ({
      sid,
      busy: !!s.pending,
      closed: s.closed,
      idle_ms: Date.now() - s.lastUsed,
      buf_bytes: s.buf.length,
    }));
  }
  close(sid) {
    const s = this.sessions.get(sid);
    if (!s) return false;
    try {
      s.child.stdin.end();
    } catch {}
    try {
      s.child.kill();
    } catch {}
    if (s.pending) {
      clearTimeout(s.pending.timer);
      s.pending.reject(new Error(`session closed sid=${sid}`));
      s.pending = null;
    }
    this.sessions.delete(sid);
    return true;
  }
  closeAll() {
    for (const sid of [...this.sessions.keys()]) this.close(sid);
    if (this._gcTimer) {
      clearInterval(this._gcTimer);
      this._gcTimer = null;
    }
    this._closed = true;
  }
  startGc() {
    if (this._gcTimer) return;
    this._gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, s] of this.sessions) {
        if (s.closed || now - s.lastUsed > this.idleTtlMs) this.close(sid);
      }
    }, this.gcIntervalMs);
    if (this._gcTimer.unref) this._gcTimer.unref();
  }
}

let _DAO_TERM_POOL = null;
function _ensureTermPool() {
  if (!_DAO_TERM_POOL) {
    _DAO_TERM_POOL = new DaoTerminalPool();
    _DAO_TERM_POOL.startGc();
    L.info("term", "DaoTerminalPool 启");
  }
  return _DAO_TERM_POOL;
}

// HTTP /term/* 服务
let _DAO_TERM_HTTP = null;
let _DAO_TERM_HTTP_PORT = 0;
function _termHttpPort() {
  const u = (os.userInfo().username || "default").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) {
    h ^= u.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 12780 + (Math.abs(h) % 50);
}
function _startDaoTermService(ctx) {
  if (_DAO_TERM_HTTP) return;
  const basePort = _termHttpPort();
  const pool = _ensureTermPool();
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    const remoteAddr = req.socket.remoteAddress || "";
    if (
      remoteAddr !== "127.0.0.1" &&
      remoteAddr !== "::1" &&
      remoteAddr !== "::ffff:127.0.0.1"
    ) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "localhost only" }));
      return;
    }
    try {
      const u = new URL(req.url, `http://127.0.0.1:${_DAO_TERM_HTTP_PORT}`);
      if (req.method === "GET" && u.pathname === "/term/ping") {
        res.end(
          JSON.stringify({
            ok: true,
            version: PKG_VERSION,
            port: _DAO_TERM_HTTP_PORT,
            sessions: pool.list().length,
          }),
        );
        return;
      }
      if (req.method === "GET" && u.pathname === "/term/list") {
        res.end(JSON.stringify({ sessions: pool.list() }));
        return;
      }
      if (req.method === "POST" && u.pathname === "/term/exec") {
        const body = await _termReadBody(req);
        const { session_id, cmd, cwd, timeout } = body || {};
        if (!session_id || !cmd) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "session_id+cmd 必填" }));
          return;
        }
        const out = await pool.exec(session_id, cmd, { cwd, timeout });
        res.end(JSON.stringify(out));
        return;
      }
      if (req.method === "POST" && u.pathname === "/term/close") {
        const body = await _termReadBody(req);
        const ok = pool.close(body.session_id);
        res.end(JSON.stringify({ closed: ok }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
  // EADDRINUSE 自动递增端口 · 道法自然 · 不争而善胜
  let tryPort = basePort;
  const maxTries = 50;
  function tryListen() {
    _DAO_TERM_HTTP_PORT = tryPort;
    server.listen(tryPort, "127.0.0.1", () => {
      L.info("term", `HTTP /term/* 启 :${tryPort} (localhost only)`);
    });
  }
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && tryPort < basePort + maxTries) {
      tryPort++;
      L.info("term", `port :${tryPort - 1} EADDRINUSE → try :${tryPort}`);
      tryListen();
    } else {
      L.warn("term", `http server err: ${e.message}`);
    }
  });
  tryListen();
  _DAO_TERM_HTTP = server;
  if (ctx && ctx.subscriptions) {
    ctx.subscriptions.push({
      dispose: () => {
        try {
          server.close();
        } catch {}
        if (_DAO_TERM_POOL) _DAO_TERM_POOL.closeAll();
        _DAO_TERM_HTTP = null;
        _DAO_TERM_POOL = null;
      },
    });
  }
}
function _termReadBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ═══════════════════════════ 命令实现 ═══════════════════════════

async function cmdInvert() {
  try {
    const { port } = cfg();
    // v11: 立即锚定 + 确保代理运行 · 无需重启Kiro
    await setAnchor(port);
    const alive = await proxyEnsure(port, "invert");
    if (alive) proxySetMode("invert");
    _cachedAnchored = true;
    L.info(
      "cmd-invert",
      `invert · anchor=✓ proxy=${alive ? "✓" : "✗"} :${port}`,
    );
    vscode.window.showInformationMessage(
      `道Agent · 已启 :${port} · SP注入即时生效`,
    );
  } catch (e) {
    vscode.window.showErrorMessage(`道Agent 启失: ${e && e.message}`);
    L.error("cmd-invert", e && e.message);
  }
}

async function cmdPassthrough() {
  try {
    const { port } = cfg();
    const alive = await proxyEnsure(port, "passthrough");
    if (alive) proxySetMode("passthrough");
    L.info("cmd-pass", `mode flipped → passthrough`);
    vscode.window.showInformationMessage(
      `官方Agent · 透传 · SP 不改 · 即时生效`,
    );
  } catch (e) {
    vscode.window.showErrorMessage(`官方Agent 切换失败: ${e && e.message}`);
    L.error("cmd-pass", e && e.message);
  }
}

async function cmdToggle() {
  const cur = proxyGetMode();
  if (cur === "invert") await cmdPassthrough();
  else await cmdInvert();
}

async function cmdOpenPreview() {
  const port = _cachedPort;
  const previewUrl = `http://127.0.0.1:${port}/origin/ping`;
  try {
    const env = await vscode.env.openExternal(vscode.Uri.parse(previewUrl));
    L.info("preview", `opened ${previewUrl}`);
  } catch (e) {
    L.warn("preview", `open fail: ${e.message}`);
  }
}

async function cmdSelftest() {
  const out = logger();
  out.show(true);
  out.appendLine("");
  out.appendLine("════════════════════════════════════════");
  out.appendLine(
    `  道Agent v${PKG_VERSION} · 自检 · ${new Date().toISOString()}`,
  );
  out.appendLine("════════════════════════════════════════");

  const { port } = cfg();

  // L1: 帛书+大常 (从 /origin/ping 取 features)
  out.appendLine("\n── L1 · 帛书+大常 (从 /origin/ping 取 features) ──");
  try {
    const r = await httpGetJson(`http://127.0.0.1:${port}/origin/ping`, 3000);
    if (r && r.features) {
      out.appendLine(
        `  ✓ 帛书《老子》: dao=${r.dao_chars}字 · header=${r.features.tao_header_chars}字 · 注入总=${r.features.inject_total_chars}字`,
      );
      out.appendLine(`  ✓ ${r.features.principle}`);
      for (const [k, v] of Object.entries(r.features.rpc_classes || {})) {
        out.appendLine(`    ${k}: ${v}`);
      }
    } else {
      out.appendLine("  ⚠ /origin/ping 无 features (代理未启?)");
    }
  } catch (e) {
    out.appendLine(`  ✗ L1 异: ${e.message}`);
  }

  // L2: proxy 路径
  out.appendLine("\n── L2 · 反代路径 ──");
  out.appendLine(
    `  port: ${port} (per-user) · anchored: ${isAnchored()} · mode: ${proxyGetMode()}`,
  );
  try {
    const ping = await httpGetJson(
      `http://127.0.0.1:${port}/origin/ping`,
      2000,
    );
    if (ping) {
      out.appendLine(
        `  ✓ proxy up: v=${ping.version} mode=${ping.mode} uptime=${ping.uptime_s}s req=${ping.req_total} cap=${ping.capture_count}`,
      );
    } else {
      out.appendLine("  ✗ proxy unreachable");
    }
  } catch (e) {
    out.appendLine(`  ✗ ping: ${e.message}`);
  }

  try {
    const last = await httpGetJson(
      `http://127.0.0.1:${port}/origin/lastinject`,
      2000,
    );
    if (last && last.has_inject) {
      out.appendLine(
        `  最近注入: ${last.at ? new Date(last.at).toISOString() : "?"} ${last.rpc || last.url || ""}`,
      );
      out.appendLine(
        `    before(${last.before_chars || 0}字): ${(last.before_head || "").slice(0, 80)}…`,
      );
      out.appendLine(
        `    after(${last.after_chars || 0}字): ${(last.after_head || "").slice(0, 80)}…`,
      );
    }
  } catch {}

  try {
    const paths = await httpGetJson(
      `http://127.0.0.1:${port}/origin/paths?n=10`,
      2000,
    );
    if (paths && paths.top && paths.top.length) {
      out.appendLine(`\n  路径直方图 (${paths.total_paths} paths):`);
      for (const p of paths.top) {
        const tags = [];
        if (p.is_chat) tags.push("CHAT");
        if (p.replaced > 0) tags.push(`✓${p.replaced}`);
        out.appendLine(
          `    ${String(p.count).padStart(5)} ${p.path} [${tags.join(",")}]`,
        );
      }
    }
  } catch {}

  // L3: 终端会话池
  out.appendLine("\n── L3 · 终端会话池 ──");
  try {
    const termPing = await httpGetJson(
      `http://127.0.0.1:${_DAO_TERM_HTTP_PORT}/term/ping`,
      1000,
    );
    out.appendLine(`  ${termPing && termPing.ok ? "✓" : "✗"} term pool`);
  } catch (e) {
    out.appendLine(`  ✗ term pool: ${e.message}`);
  }

  out.appendLine("\n── L4 · 活检指引 ──");
  out.appendLine(`  1. 运行 "道Agent: 启" → endpoints 写入 → 重启 Kiro`);
  out.appendLine(`  2. 向 Kiro agent 问 '你是谁'`);
  out.appendLine(`  3. 期答含 '道'/'无为'/'自然' (帛书德道经 SP 注入成功)`);
  out.appendLine("════════════════════════════════════════\n");
}

// v12.6: 全链路自检 · 对齐 windsurf wam.verifyEndToEnd · 自足证隔离(不打 AWS)
async function cmdVerifyEndToEnd() {
  const out = logger();
  out.show(true);
  out.appendLine("");
  out.appendLine("════════════════════════════════════════");
  out.appendLine(`  道Agent · 全链路自检(verifyEndToEnd) · ${new Date().toISOString()}`);
  out.appendLine("════════════════════════════════════════");
  const { port } = cfg();
  try {
    const r = await httpGetJson(`http://127.0.0.1:${port}/origin/verify`, 4000);
    if (!r || !Array.isArray(r.checks)) {
      out.appendLine("  ✗ /origin/verify 无响应 (代理未启?)");
      vscode.window.showWarningMessage("道Agent 自检: 代理未响应");
      return;
    }
    out.appendLine(
      `  v=${r.version} · mode=${r.mode} · 经文=${r.scripture_mode}(${r.canon_chars}字)`,
    );
    const passed = r.checks.filter((c) => c.pass).length;
    for (const c of r.checks) {
      out.appendLine(`  ${c.pass ? "✓" : "✗"} ${c.name}${c.error ? " · " + c.error : ""}`);
    }
    out.appendLine(
      `\n  结论: ${r.ok ? "PASS" : "FAIL"} (${passed}/${r.checks.length})`,
    );
    out.appendLine("════════════════════════════════════════\n");
    if (r.ok) {
      vscode.window.showInformationMessage(
        `道Agent 全链路自检 PASS (${passed}/${r.checks.length}) · 隔离生效`,
      );
    } else {
      vscode.window.showWarningMessage(
        `道Agent 全链路自检 FAIL (${passed}/${r.checks.length}) · 见输出面板`,
      );
    }
  } catch (e) {
    out.appendLine(`  ✗ verify 异: ${e.message}`);
    vscode.window.showErrorMessage(`道Agent 自检失败: ${e.message}`);
  }
}

async function cmdTermExec() {
  try {
    const sid = await vscode.window.showInputBox({
      prompt: "session_id",
      value: "agent_default",
    });
    if (!sid) return;
    const cmd = await vscode.window.showInputBox({
      prompt: `命令 · sid=${sid}`,
      placeHolder:
        process.platform === "win32" ? "echo hello & dir" : "echo hello && ls",
    });
    if (!cmd) return;
    const pool = _ensureTermPool();
    const r = await pool.exec(sid, cmd);
    const stdoutSnip =
      r.stdout.length > 800 ? r.stdout.slice(0, 800) + " ..." : r.stdout;
    vscode.window.showInformationMessage(
      `[${sid}] exit=${r.exit} · stdout=${stdoutSnip}`,
      { modal: false },
    );
  } catch (e) {
    L.error("term", `cmdTermExec fail: ${e.message}`);
    vscode.window.showErrorMessage(`term.exec 失: ${e.message}`);
  }
}

async function cmdTermList() {
  const pool = _ensureTermPool();
  const lst = pool.list();
  const lines =
    lst.length === 0
      ? "(无会话)"
      : lst
          .map(
            (s) =>
              `${s.sid} · busy=${s.busy} · idle=${Math.round(s.idle_ms / 1000)}s`,
          )
          .join("\n");
  vscode.window.showInformationMessage(
    `终端会话池 (${lst.length}) · :${_DAO_TERM_HTTP_PORT}\n${lines}`,
    { modal: true },
  );
}

async function cmdTermClose() {
  const pool = _ensureTermPool();
  const lst = pool.list();
  if (lst.length === 0) {
    vscode.window.showInformationMessage("终端会话池: 无会话");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    lst.map((s) => ({
      label: s.sid,
      description: `busy=${s.busy} idle=${Math.round(s.idle_ms / 1000)}s`,
    })),
    { placeHolder: "选会话关闭" },
  );
  if (!pick) return;
  const ok = pool.close(pick.label);
  vscode.window.showInformationMessage(
    `close ${pick.label} · ${ok ? "ok" : "fail"}`,
  );
}

// ═══════════════════════════ 本源观照 · EssenceProvider ═══════════════════════════
// 道义: 三十二章 "道恒无名 · 侯王若能守之 · 万物将自宾"
// webview 面板 · 道/官模式热切换 · 经文版本切换 · 本源观照

function _genNonce() {
  const b = crypto.randomBytes(16);
  return b.toString("base64").replace(/[+/=]/g, "");
}

function _escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 加载帛书经文 (SSR 用)
function _loadSilkForWebview() {
  try {
    const vendorDir = path.join(__dirname, "vendor", "bundled-origin");
    const deFp = path.join(vendorDir, "_silk_de.txt");
    const daoFp = path.join(vendorDir, "_silk_dao.txt");
    const yinfuFp = path.join(vendorDir, "_yinfu.txt");
    if (!fs.existsSync(deFp) || !fs.existsSync(daoFp)) return "";
    const deText = fs.readFileSync(deFp, "utf8").trim();
    const daoText = fs.readFileSync(daoFp, "utf8").trim();
    const yinfuText = fs.existsSync(yinfuFp)
      ? fs.readFileSync(yinfuFp, "utf8").trim()
      : "";
    if (!deText || !daoText) return "";
    // v12.5: 对齐 WindSurf 大道至简 · 与 kiro-dao-proxy.js _getDaoHeader() 一致
    const TAO_HEADER =
      "你本無名 名可名也 非恒名也 所遵從之一切均來自於下述帛書《老子》和道藏《陰符經》：\n\n";
    // v10: 纯经文 · 无标签装饰 · 与 proxy _buildCanonForMode("full") 一致
    return (
      TAO_HEADER +
      deText +
      "\n\n" +
      daoText +
      (yinfuText ? "\n\n" + yinfuText : "")
    );
  } catch {
    return "";
  }
}

function getEssenceHtml(port, nonce, initialSP, webview, extensionUri) {
  const N = nonce || _genNonce();
  const proxyPort = port || 0;
  // v10.1 · 守一归宗 · 与 Windsurf proxy-pro 完全同构 · inline nonce script
  // 道义: 三十二章「道恒无名·侯王若能守之·万物将自宾」· 守一不散
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${N}'; connect-src http://127.0.0.1:* http://localhost:*; img-src data:;">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, transparent);
    margin: 0; padding: 6px 8px; font-size: 12px; line-height: 1.55;
    display: flex; flex-direction: column;
  }
  .bar { display: flex; gap: 3px; align-items: center; margin-bottom: 3px; flex: 0 0 auto; font-size: 10px; flex-wrap: wrap; }
  .ib {
    padding: 2px 5px; font-size: 12px; border: 1px solid transparent;
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; border-radius: 2px; font-family: inherit;
    opacity: 0.55; min-width: 20px; line-height: 1;
  }
  .ib:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .ib.edit-active { opacity: 1; color: #e8a040; border-color: #e8a040; background: rgba(232,160,64,0.1); }
  .mb {
    padding: 1px 7px; font-size: 11px; border: 1px solid rgba(128,128,128,0.3);
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; border-radius: 3px; font-family: inherit;
    opacity: 0.55; line-height: 1.3; transition: all 0.15s; font-weight: 500;
  }
  .mb:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .mb.active { opacity: 1; border-color: var(--vscode-textLink-foreground, #4fc1ff); color: var(--vscode-textLink-foreground, #4fc1ff); background: rgba(79,193,255,0.1); font-weight: 700; }
  .mb.active-dao { border-color: #6bb86b; color: #6bb86b; background: rgba(107,184,107,0.1); }
  .dots { display: inline-flex; gap: 2px; align-items: center; padding: 0 4px; cursor: help; }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: rgba(128,128,128,0.3); }
  .dot.ok { background: #6bb86b; } .dot.warn { background: #d9a200; } .dot.err { background: #e08080; }
  .stat { font-size: 10px; opacity: 0.55; margin: 0 0 4px; line-height: 1.4; font-family: monospace; display: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stat.show { display: block; }
  .stat .pill { padding: 1px 5px; border-radius: 2px; background: rgba(128,128,128,0.12); margin-right: 4px; overflow: hidden; text-overflow: ellipsis; }
  #sp {
    flex: 1 1 auto; overflow: auto; margin: 0; padding: 10px 12px;
    font-family: "Noto Serif CJK SC", "Microsoft YaHei", var(--vscode-editor-font-family), serif;
    font-size: 11.5px; line-height: 1.75; white-space: pre-wrap; word-break: break-word;
    background: rgba(0,0,0,0.08); border-radius: 3px;
  }
  #sp.quiet { text-align: center; opacity: 0.5; font-style: italic; padding: 40px 0; letter-spacing: 1px; }
  #editArea { display: none; flex: 1 1 auto; flex-direction: column; }
  #editArea.show { display: flex; }
  #editArea textarea {
    flex: 1 1 auto; resize: none; border: 1px solid rgba(128,128,128,0.3); border-radius: 3px; padding: 8px 10px;
    font-family: "Noto Serif CJK SC", "Microsoft YaHei", var(--vscode-editor-font-family), serif;
    font-size: 11.5px; line-height: 1.75;
    background: var(--vscode-input-background, rgba(0,0,0,0.12)); color: var(--vscode-input-foreground, var(--vscode-foreground));
    outline: none; min-height: 120px;
  }
  #editArea textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .edit-bar { display: flex; gap: 4px; align-items: center; margin-top: 4px; flex: 0 0 auto; font-size: 10px; }
  .edit-bar .eb {
    padding: 2px 8px; font-size: 10px; border: 1px solid rgba(128,128,128,0.3);
    background: transparent; color: var(--vscode-foreground); cursor: pointer; border-radius: 3px;
    font-family: inherit; line-height: 1.4; transition: all 0.15s;
  }
  .edit-bar .eb:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
  .edit-bar .eb.save { border-color: #6bb86b; color: #6bb86b; }
  .edit-bar .eb.save:hover { background: rgba(107,184,107,0.15); }
  .edit-bar .eb.reset { border-color: #e08080; color: #e08080; }
  .edit-bar .eb.reset:hover { background: rgba(224,128,128,0.15); }
  .edit-bar .edit-status { opacity: 0.7; margin-left: auto; font-size: 9px; }
  .edit-bar .edit-count { opacity: 0.55; font-size: 9px; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .edit-bar .eb.reload { border-color: #80b0e0; color: #80b0e0; }
  .edit-bar .eb.reload:hover { background: rgba(128,176,224,0.15); }
  .edit-hint { font-size: 9px; opacity: 0.55; margin-bottom: 3px; padding: 2px 4px; font-style: italic; flex: 0 0 auto; }
  .custom-badge { display: inline-block; font-size: 8px; padding: 0 4px; border-radius: 2px; background: rgba(232,160,64,0.2); color: #e8a040; border: 1px solid rgba(232,160,64,0.3); margin-left: 4px; }
  #canonSelect { font-size: 10px; padding: 1px 2px; border: 1px solid rgba(128,128,128,0.3); background: var(--vscode-dropdown-background, rgba(0,0,0,0.2)); color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); border-radius: 3px; cursor: pointer; outline: none; font-family: inherit; max-width: 96px; margin-left: 4px; }
  #canonSelect:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  #canonSelect option { background: var(--vscode-dropdown-listBackground, #252526); color: var(--vscode-dropdown-foreground, #ccc); }
</style>
</head>
<body data-port="${proxyPort}">
  <div class="bar">
    <span class="dots" id="dots" title="Proxy·Capture·Mode"></span>
    <button class="mb" id="btnDao" title="道Agent·帛书前置">道</button>
    <button class="mb" id="btnOff" title="官方Agent·透传">官</button>
    <button class="ib" id="editToggle" title="编辑注入 SP">编</button>
    <select id="canonSelect" title="经藏切换 · 两经归一·道生一">
      <option value="laozi+yinfu">帛书老子+道藏阴符经</option>
      <option value="laozi">帛书《老子》</option>
      <option value="yinfu">道藏《阴符经》</option>
    </select>
    <span id="customBadge"></span>
  </div>
  <div class="stat" id="stat"></div>
  <pre id="sp" class="quiet">${initialSP ? _escapeHtml(initialSP) : "（待首次对话）"}</pre>
  <div id="editArea">
    <div class="edit-hint">编此 · 改道 agent 注入 LLM 之 SP (帛书德道经) · Ctrl+Enter 保存 · Esc 关</div>
    <textarea id="editText" placeholder="编辑道 agent 模式注入 LLM 之核心 SP (帛书《老子》) · 改此即改注入 · 保存后下次 chat 即生效"></textarea>
    <div class="edit-bar">
      <button class="eb save" id="editSave" title="保存注入 (Ctrl+Enter)">✔ 注入</button>
      <button class="eb reload" id="editReload" title="重载当前 LLM 实收 SP (不保存)">载</button>
      <button class="eb reset" id="editReset" title="清 _customSP · 回默道德经路径">✖ 归道</button>
      <span class="edit-count" id="editCount"></span>
      <span class="edit-status" id="editStatus"></span>
    </div>
  </div>
  <noscript><div style="padding:16px;color:#e08080;font-size:11px">脚本被 CSP 拦截 · 请重载</div></noscript>
<script nonce="${N}">
(function() {
  'use strict';
  var _PORT = ${proxyPort};
  var _BASE = 'http://127.0.0.1:' + _PORT;

  function _wdbg(msg, tag, data) {
    try {
      fetch(_BASE + '/origin/_wdbg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: msg || '', tag: tag || '', data: data || null }),
        cache: 'no-store'
      }).catch(function(){});
    } catch(_) {}
  }
  _wdbg('iife-start', 'boot', { port: _PORT, href: location.href, ts: Date.now() });

  try {
    window.addEventListener('error', function(ev) {
      _wdbg('window-error', 'fatal', {
        msg: ev && ev.message,
        src: ev && ev.filename,
        line: ev && ev.lineno,
        col: ev && ev.colno,
        stack: ev && ev.error && ev.error.stack && String(ev.error.stack).slice(0, 500)
      });
    });
    window.addEventListener('unhandledrejection', function(ev) {
      _wdbg('unhandled-rejection', 'fatal', { reason: ev && String(ev.reason).slice(0, 300) });
    });
  } catch(_) {}

  var vsc;
  try { vsc = acquireVsCodeApi(); _wdbg('vsc-acquired', 'boot'); }
  catch(e) { vsc = { postMessage: function(){ return false; }, _ghost: true }; _wdbg('vsc-fail', 'boot', e.message); }

  var $sp = document.getElementById('sp');
  var $stat = document.getElementById('stat');
  var $dots = document.getElementById('dots');
  var $btnDao = document.getElementById('btnDao');
  var $btnOff = document.getElementById('btnOff');
  var $editToggle = document.getElementById('editToggle');
  var $editArea = document.getElementById('editArea');
  var $editText = document.getElementById('editText');
  var $editSave = document.getElementById('editSave');
  var $editReload = document.getElementById('editReload');
  var $editReset = document.getElementById('editReset');
  var $editStatus = document.getElementById('editStatus');
  var $editCount = document.getElementById('editCount');
  var $customBadge = document.getElementById('customBadge');
  var $canonSelect = document.getElementById('canonSelect');
  var lastText = '';
  var lastSP = ${initialSP ? JSON.stringify(initialSP) : "''"};
  var lastEntry = null;
  var lastSig = '';
  var curMode = 'invert';
  var editMode = false;

  function _spCanonPart(s) {
    if (!s) return '';
    var sep = '\\n\\n---\\n\\n';
    var idx = s.indexOf(sep);
    return idx >= 0 ? s.slice(0, idx) : s;
  }
  var _editClosing = null;

  function fJson(p) { return fetch(_BASE + p, { cache: 'no-store' }).then(function(r){ if (!r.ok) throw new Error('http ' + r.status); return r.json(); }); }

  function renderTapeEntry(entry, ts) {
    if (!entry) return false;
    lastEntry = entry;
    var _sp = entry.after || entry.before || '';
    if (!_sp && entry.all_fields && entry.all_fields.length > 0) {
      var _spKinds = ['chat', 'summary', 'memory', 'ephemeral', 'unknown_long'];
      for (var _si = 0; _si < entry.all_fields.length; _si++) {
        if (_spKinds.indexOf(entry.all_fields[_si].kind) >= 0) {
          _sp = entry.all_fields[_si].text || '';
          break;
        }
      }
      if (!_sp) _sp = entry.all_fields[0].text || '';
    }
    lastSP = _sp;
    var parts = [];
    var totalChars = 0;
    var fieldCount = (entry.all_fields && entry.all_fields.length) || 0;
    if (fieldCount > 0) {
      for (var i = 0; i < fieldCount; i++) {
        var f = entry.all_fields[i];
        parts.push('━━━ #' + (i + 1) + '/' + fieldCount + ' · ' + (f.chars || 0) + '字 ━━━');
        parts.push(f.text || '');
        parts.push('');
        totalChars += (f.chars || 0);
      }
    } else if (lastSP) {
      parts.push('━━━ LLM 实收 · ' + lastSP.length + '字 ━━━');
      parts.push(lastSP);
      totalChars += lastSP.length;
    }
    if (parts.length === 0) return false;
    var text = parts.join('\\n');
    lastText = text;
    if (!editMode) {
      $sp.classList.remove('quiet');
      $sp.textContent = text;
    }
    if (fieldCount > 0) {
      $stat.innerHTML = '<span class="pill">全·' + fieldCount + '字段·' + totalChars + '字</span>';
    } else if (lastSP) {
      $stat.innerHTML = '<span class="pill">全·1字段·' + lastSP.length + '字</span>';
    } else {
      $stat.innerHTML = '';
    }
    return true;
  }

  function setModeUI(mode) {
    curMode = mode || 'invert';
    $btnDao.classList.remove('active', 'active-dao');
    $btnOff.classList.remove('active');
    $editToggle.classList.remove('edit-active');
    if (curMode === 'invert') $btnDao.classList.add('active', 'active-dao');
    else $btnOff.classList.add('active');
    // v10.3.1: 道/官切换时退出编模式 · 三选一互斥
    if (editMode && curMode !== 'edit') _closeEditMode();
  }
  $btnDao.addEventListener('click', function() {
    if (curMode === 'invert' && !editMode) return;
    // v10.3.1: 点道即退出编 · 三选一
    if (editMode) _closeEditMode();
    setModeUI('invert');
    vsc.postMessage({ command: 'setMode', mode: 'dao' });
  });
  $btnOff.addEventListener('click', function() {
    if (curMode === 'passthrough' && !editMode) return;
    // v10.3.1: 点官即退出编 · 三选一
    if (editMode) _closeEditMode();
    setModeUI('passthrough');
    vsc.postMessage({ command: 'setMode', mode: 'official' });
  });

  $canonSelect.addEventListener('change', function() {
    var c = $canonSelect.value;
    vsc.postMessage({ command: 'setCanon', canon: c });
  });

  function _closeEditMode() {
    editMode = false;
    $editArea.classList.remove('show');
    $editToggle.classList.remove('edit-active');
    $sp.style.display = '';
    if (_editClosing) { clearTimeout(_editClosing); _editClosing = null; }
  }
  function updateEditCount() {
    var n = ($editText.value || '').length;
    var d = (lastSP || '').length;
    $editCount.textContent = n + (d > 0 ? '/' + d : '') + '字';
  }
  $editToggle.addEventListener('click', function() {
    editMode = !editMode;
    if (editMode) {
      // v10.3.1: 编模式 · 三选一 · 高亮编按钮
      $editArea.classList.add('show');
      $editToggle.classList.add('edit-active');
      $btnDao.classList.remove('active', 'active-dao');
      $btnOff.classList.remove('active');
      $sp.style.display = 'none';
      $editText.value = '';
      updateEditCount();
      $editStatus.textContent = '加载中…';
      vsc.postMessage({ command: 'getCustomSP' });
      $editText.focus();
    } else {
      _closeEditMode();
      // v10.3.1: 退出编 → 恢复道/官高亮
      setModeUI(curMode);
    }
  });
  $editSave.addEventListener('click', function() {
    var sp = $editText.value;
    if (!sp || !sp.trim()) { $editStatus.textContent = '✖ 内容不可为空'; return; }
    $editStatus.textContent = '保存中…';
    vsc.postMessage({ command: 'setCustomSP', sp: sp.trim() });
  });
  $editReload.addEventListener('click', function() {
    $editText.value = _spCanonPart(lastSP);
    updateEditCount();
    $editStatus.textContent = '✔ 已载当前实收 SP · ' + (_spCanonPart(lastSP).length) + '字';
    $editText.focus();
  });
  $editReset.addEventListener('click', function() {
    $editStatus.textContent = '清除中…';
    vsc.postMessage({ command: 'resetCustomSP' });
  });
  $editText.addEventListener('input', updateEditCount);
  $editText.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $editSave.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); _closeEditMode(); }
  });

  function updateCustomBadge(isCustom, chars) {
    if (isCustom) $customBadge.innerHTML = '<span class="custom-badge">自定义' + (chars ? ' ' + chars + '字' : '') + '</span>';
    else $customBadge.innerHTML = '';
  }

  function setDots(p) {
    $dots.innerHTML = '';
    if (!p || !p.ok) {
      var d = document.createElement('span');
      d.className = 'dot err';
      $dots.appendChild(d);
      $dots.title = 'Proxy:✗';
      return;
    }
    var items = [
      { label: 'Proxy', on: true, k: 'proxy' },
      { label: 'Capture', on: !!(p.tape_count > 0), k: 'cap' },
      { label: 'Mode', on: p.mode === 'invert', k: 'mode' }
    ];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var d2 = document.createElement('span');
      d2.className = 'dot ' + (it.on ? 'ok' : (it.k === 'cap' ? 'warn' : 'err'));
      $dots.appendChild(d2);
    }
    $dots.title = 'Proxy:' + (items[0].on?'✓':'✗') + ' · Cap:' + (items[1].on?'✓':'✗') + ' · M:' + (p.mode||'?');
  }

  function pingPull() {
    fJson('/origin/ping').then(function(p){
      if (!p) return;
      if (p.mode) setModeUI(p.mode);
      // v10.3.1: ping返回scripture_mode · 映射到下拉框值
      var _sm = p.scripture_mode || p.canon;
      if (_sm) {
        var _sv = { laozi: 'laozi', yinfu: 'yinfu', full: 'laozi+yinfu' }[_sm] || _sm;
        if ($canonSelect.value !== _sv) $canonSelect.value = _sv;
      }
      setDots(p);
      if (p.custom_sp != null) updateCustomBadge(p.custom_sp, p.custom_sp_chars);
    }).catch(function(){ setDots(null); });
  }

  function pull() {
    if (!_PORT) return;
    fJson('/origin/tape?limit=1&fields=0').then(function(resp) {
      if (resp && resp.ok && resp.tape && resp.tape.length > 0) {
        renderTapeEntry(resp.tape[0], new Date().toLocaleTimeString());
      } else {
        if (!editMode) {
          $sp.classList.add('quiet');
          $sp.textContent = '（待首次对话）';
        }
        $stat.innerHTML = '';
      }
    }).catch(function(){});
  }

  function sigTick() {
    fJson('/origin/sig').then(function(r){
      if (!r || !r.ok) return;
      var cur = (r.injects_last_at || 0) + '|' + (r.injects_count || 0) + '|' + (r.tape_last_at || 0) + '|' + (r.mode_sig || '');
      if (cur === lastSig) return;
      lastSig = cur;
      pingPull();
      pull();
    }).catch(function(){});
  }

  window.addEventListener('message', function(e) {
    if (!e.data) return;
    try { _wdbg('msg-recv', String(e.data.command || e.data.type || '?'), { keys: Object.keys(e.data).slice(0, 8) }); } catch(_) {}
    if (e.data.command === '_diag-ping') return;
    if (e.data.type === 'mode') setModeUI(e.data.mode);
    if (e.data.type === 'data') {
      var _d = e.data.data;
      if (!_d) return;
      if (_d.ping && _d.ping.mode) setModeUI(_d.ping.mode);
      if (_d.ping) setDots(_d.ping);
      // v10.3.1: ping返回scripture_mode
      if (_d.ping) {
        var _sm2 = _d.ping.scripture_mode || _d.ping.canon;
        if (_sm2) {
          var _sv2 = { laozi: 'laozi', yinfu: 'yinfu', full: 'laozi+yinfu' }[_sm2] || _sm2;
          if ($canonSelect.value !== _sv2) $canonSelect.value = _sv2;
        }
      }
      if (_d.ping && _d.ping.custom_sp != null) updateCustomBadge(_d.ping.custom_sp, _d.ping.custom_sp_chars);
      if (_d.proxy && _d.proxy.after) {
        lastSP = _d.proxy.after;
        if (!editMode) {
          $sp.classList.remove('quiet');
          $sp.textContent = _d.proxy.after;
        }
        var _ageS = (_d.proxy.age_s != null) ? Math.round(_d.proxy.age_s) : null;
        var _pill = _d.proxy.after.length + '字';
        if (_ageS != null) _pill += ' · ' + _ageS + 's前';
        if (_d.ping && _d.ping.canon_name) _pill += ' · ' + _d.ping.canon_name;
        $stat.innerHTML = '<span class="pill">' + _pill + '</span>';
        $stat.classList.add('show');
      } else if (_d.proxyUp === false) {
        if (!editMode) {
          $sp.classList.add('quiet');
          $sp.textContent = '（待首次对话）';
        }
        $stat.innerHTML = '';
      }
      return;
    }
    if (e.data.type === 'canonChanged') {
      var _cc = e.data;
      if (!_cc.has_custom && _cc.default_sp) {
        lastSP = _cc.default_sp;
        if (!editMode) {
          $sp.classList.remove('quiet');
          $sp.textContent = _cc.default_sp;
        } else {
          $editText.value = _cc.default_sp;
          updateEditCount();
          $editStatus.textContent = '经藏已切 · ' + (_cc.default_source_name || _cc.canon || '?') + ' ' + (_cc.default_chars || 0) + '字';
        }
      }
      // v10.3.1: 映射代理canon值到下拉框
      if (_cc.canon) {
        var _cv = { laozi: 'laozi', yinfu: 'yinfu', full: 'laozi+yinfu' }[_cc.canon] || _cc.canon;
        if ($canonSelect.value !== _cv) $canonSelect.value = _cv;
      }
      var _ccPill = (_cc.default_chars || 0) + '字';
      if (_cc.default_source_name) _ccPill += ' · ' + _cc.default_source_name;
      $stat.innerHTML = '<span class="pill">' + _ccPill + '</span>';
      $stat.classList.add('show');
      return;
    }
    if (e.data.type === 'customSP') {
      var r = e.data;
      if (r.action === 'get') {
        if (r.default_sp) lastSP = r.default_sp;
        if (r.has_custom && r.sp) {
          $editText.value = r.sp;
          updateEditCount();
          updateCustomBadge(true, r.chars);
          $editStatus.textContent = '自定义 · ' + (r.chars || 0) + '字';
        } else {
          updateCustomBadge(false);
          if (r.default_sp) {
            $editText.value = r.default_sp;
          }
          updateEditCount();
          var _srcLabel = r.default_source_name || (r.default_source === 'silk' ? '帛书本源' : (r.default_source || '默认'));
          $editStatus.textContent = '未设 · ' + _srcLabel + ' ' + (r.default_chars || 0) + '字';
        }
      } else if (r.action === 'set') {
        if (r.ok) {
          $editStatus.textContent = '✔ 已注入 ' + (r.chars || 0) + '字';
          updateCustomBadge(true, r.chars);
          updateEditCount();
          if (_editClosing) clearTimeout(_editClosing);
          _editClosing = setTimeout(_closeEditMode, 1500);
        } else $editStatus.textContent = '✖ 失败: ' + (r.error || '?');
      } else if (r.action === 'reset') {
        if (r.ok) {
          $editStatus.textContent = '归道中…';
          updateCustomBadge(false);
          // v10.3.1: 归道 = 清自定义 + 回默认full经文模式
          fJson('/origin/custom_sp').then(function(g) {
            if (g && g.default_sp) {
              $editText.value = g.default_sp;
              lastSP = g.default_sp;
              updateEditCount();
              $editStatus.textContent = '✔ 已归道 · ' + (g.default_source_name || '帛书本源') + ' ' + (g.default_chars || 0) + '字';
            } else {
              $editStatus.textContent = '✖ 归道拉源失败';
            }
          }).catch(function(){ $editStatus.textContent = '✖ 归道网络异'; });
          // v10.3.1: 归道同时切回full经文模式
          fPost('/origin/canon', { canon: 'full' }).then(function(cr) {
            if (cr && cr.ok) {
              if ($canonSelect.value !== 'laozi+yinfu') $canonSelect.value = 'laozi+yinfu';
            }
          }).catch(function(){});
          // v10.3.1: 归道后刷新观照面板
          setTimeout(function(){ pingPull(); pull(); }, 500);
        } else $editStatus.textContent = '✖ 清除失败';
      }
    }
  });

  pingPull();
  pull();
  vsc.postMessage({ command: 'getCustomSP' });
  vsc.postMessage({ command: 'refresh' });
  setTimeout(function(){ pingPull(); pull(); vsc.postMessage({ command: 'refresh' }); }, 3000);
  setInterval(sigTick, 5000);
  setInterval(pingPull, 10000);
  setInterval(pull, 30000);
  setInterval(function() { vsc.postMessage({ command: 'refresh' }); }, 15000);
  _wdbg('boot-done', 'boot', { listeners: 'btnDao,btnOff,canon,editToggle,editSave,editReload,editReset,message[data,customSP,canonChanged]', ver: '10.1' });
})();
</script>
</body>
</html>`;
}

class EssenceProvider {
  constructor(ctx) {
    this._ctx = ctx;
    this._view = null;
    this._timer = null;
    this._sigTimer = null;
    this._busy = false;
    this._lastSig = "";
    this._sse = null;
    this._sseLastSpSig = "";
    this._setupSse();
  }

  _setupSse() {
    try {
      this._sse = new DaoSseClient(_cachedPort);
      this._sse.on("sp", (ev) => {
        if (!this._view) return;
        const sig = ev && ev.sig;
        if (sig && sig === this._sseLastSpSig) return;
        this._sseLastSpSig = sig || "";
        this.forceRefresh().catch(() => {});
      });
      this._sse.on("mode", (ev) => {
        if (!this._view) return;
        _cachedMode = (ev && ev.mode) || _cachedMode;
        try {
          this._view.webview.postMessage({ type: "mode", mode: ev && ev.mode });
        } catch {}
      });
      this._sse.on("connect", () => {
        if (this._view) this.forceRefresh().catch(() => {});
      });
      this._sse.start();
    } catch {
      this._sse = null;
    }
  }

  resolveWebviewView(webviewView) {
    L.info("webview", `resolveWebviewView called · port=${_cachedPort}`);
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      portMapping: [
        { webviewPort: _cachedPort, extensionHostPort: _cachedPort },
      ],
    };
    // SSR 道魂直嵌 · webview 一加载就见帛书全文
    const ssrSp = _loadSilkForWebview();
    L.info(
      "webview",
      `SSR load · silk_chars=${ssrSp.length} port=${_cachedPort}`,
    );
    const _html = getEssenceHtml(
      _cachedPort,
      null,
      ssrSp,
      webviewView.webview,
      this._ctx.extensionUri,
    );
    webviewView.webview.html = _html;
    // 强制 show webview · collapsed 时 JS 不跑
    try {
      webviewView.show(true);
      L.info("webview", `forced show(true) · visible=${webviewView.visible}`);
    } catch (e) {
      L.warn("webview", `show fail: ${e.message}`);
    }
    // dump 实际 html 到磁盘 · 离线诊
    try {
      const dumpFp = path.join(os.homedir(), ".dao-webview-dump.html");
      fs.writeFileSync(dumpFp, _html, "utf8");
      L.info(
        "webview",
        `dumped html → ${dumpFp} (overwrite · v${PKG_VERSION})`,
      );
    } catch (e) {
      L.warn("webview", `dump fail: ${e.message}`);
    }
    try {
      const _portMatch = _html.match(/var _PORT = ([^;]+);/);
      const _baseMatch = _html.match(/var _BASE = ([^;]+);/);
      const _hasIife = _html.indexOf("_wdbg('iife-start'") >= 0;
      const _hasPull = _html.indexOf("function pull(") >= 0;
      const _hasWdbg = _html.indexOf("function _wdbg(") >= 0;
      L.info(
        "webview",
        `html set · len=${_html.length} _PORT=${_portMatch ? _portMatch[1] : "?"} _BASE=${_baseMatch ? _baseMatch[1] : "?"} hasIife=${_hasIife} hasPull=${_hasPull} hasWdbg=${_hasWdbg}`,
      );
    } catch (e) {
      L.warn("webview", `html dbg fail: ${e.message}`);
    }

    // 收 webview 消息
    webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        if (!msg) return;
        try {
          if (msg.command === "stage") {
            L.info("webview.stage", String(msg.stage || "?").slice(0, 120));
            return;
          }
          if (msg.command === "refresh") await this.refresh();
          else if (msg.command === "setMode")
            await this._handleSetMode(msg.mode);
          else if (msg.command === "getCustomSP")
            await this._handleGetCustomSP();
          else if (msg.command === "setCustomSP")
            await this._handleSetCustomSP(msg);
          else if (msg.command === "resetCustomSP")
            await this._handleResetCustomSP();
          else if (msg.command === "setCanon")
            await this._handleSetCanon(msg.canon);
        } catch {}
      },
      null,
      this._ctx.subscriptions,
    );

    // 5s 自检 webview 是否真活
    setTimeout(async () => {
      try {
        if (this._view) {
          this._view.webview.postMessage({
            command: "_diag-ping",
            ts: Date.now(),
          });
        }
        L.info("webview", "5s diag ping sent");
      } catch (e) {
        L.warn("webview", `5s diag fail: ${e.message}`);
      }
    }, 5000);

    webviewView.onDidChangeVisibility(() => {
      L.info("webview", `visibility → ${webviewView.visible}`);
      if (webviewView.visible) {
        this.refresh().catch((e) =>
          L.warn("refresh", `vis fail: ${e.message}`),
        );
        this._armTimer();
      } else this._stopTimer();
    });
    webviewView.onDidDispose(() => {
      L.info("webview", "disposed");
      this._view = null;
      this._stopTimer();
    });
    this._armTimer();
    // 主动首推 · 不依赖 webview 'refresh' 消息
    setTimeout(() => this.refresh().catch(() => {}), 3000);
    setTimeout(() => this.refresh().catch(() => {}), 8000);
    setTimeout(() => this.refresh().catch(() => {}), 15000);
  }

  _armTimer() {
    this._stopTimer();
    if (!this._view || !this._view.visible) return;
    this._timer = setInterval(() => this.refresh().catch(() => {}), 30000);
    this._sigTimer = setInterval(() => this._sigTick().catch(() => {}), 5000);
  }
  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._sigTimer) {
      clearInterval(this._sigTimer);
      this._sigTimer = null;
    }
  }

  async _sigTick() {
    if (!this._view || !this._view.visible || this._busy) return;
    if (this._sse && this._sse.isConnected()) {
      this._sigSkipCounter = (this._sigSkipCounter || 0) + 1;
      if (this._sigSkipCounter % 10 !== 0) return;
    }
    try {
      const sig = await httpGetJson(
        `http://127.0.0.1:${_cachedPort}/origin/sig`,
        800,
      );
      if (!sig || !sig.ok) return;
      const cur = `${sig.mode}|${sig.sp_sig}|${sig.custom_sig || "0"}|${sig.custom_sp_at || 0}|${sig.injects_last_at || 0}|${sig.spc_last_at || 0}|${sig.injects_count || 0}`;
      if (cur === this._lastSig) return;
      this._lastSig = cur;
      this.refresh().catch(() => {});
    } catch {}
  }

  async refresh() {
    if (!this._view) {
      L.info("refresh", "skip · _view null");
      return;
    }
    if (this._busy) {
      L.info("refresh", "skip · busy");
      return;
    }
    this._busy = true;
    try {
      const data = await gatherEssence(_cachedPort);
      if (!this._view) {
        L.info("refresh", "skip · _view became null after gather");
        return;
      }
      data.modeLabel = getModeLabel();
      data._port = _cachedPort;
      const afterChars =
        (data.proxy &&
          (data.proxy.after_chars || (data.proxy.after || "").length)) ||
        0;
      // 损之又损 · 精简postMessage · 去大对象 · 防IPC过载
      const slimProxy = data.proxy
        ? {
            ok: data.proxy.ok,
            after: data.proxy.after,
            after_chars: afterChars,
            age_s: data.proxy.age_s,
            has_captured_before: data.proxy.has_captured_before,
            before_chars: data.proxy.before_chars,
          }
        : null;
      const slimData = {
        ts: data.ts,
        ping: data.ping,
        proxyUp: data.proxyUp,
        proxy: slimProxy,
        modeLabel: data.modeLabel,
        _port: data._port,
      };
      try {
        const ok = await this._view.webview.postMessage({
          type: "data",
          data: slimData,
        });
        L.info(
          "refresh",
          `postMessage ok=${ok} · proxy=${!!slimProxy} · after=${afterChars} · visible=${this._view.visible}`,
        );
        if (!ok)
          L.warn("refresh", "postMessage returned false (webview not ready?)");
      } catch (e) {
        L.warn("refresh", `postMessage error: ${e.message}`);
      }
    } catch (e) {
      L.warn("refresh", `gather/send error: ${e.message}`);
    } finally {
      this._busy = false;
    }
  }

  async forceRefresh() {
    this._busy = false;
    await this.refresh();
  }

  async _handleSetMode(mode) {
    if (mode === "dao" || mode === "invert") await cmdInvert();
    else await cmdPassthrough();
    this._lastSig = "";
    setTimeout(() => this.forceRefresh().catch(() => {}), 300);
  }

  async _handleGetCustomSP() {
    if (!this._view) return;
    try {
      const r = await httpGetJson(
        `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
        2000,
      );
      await this._view.webview.postMessage({
        type: "customSP",
        action: "get",
        has_custom: r && r.has_custom,
        sp: r && r.sp,
        chars: r && r.chars,
        keep_blocks: r && r.keep_blocks,
        default_sp: r && r.default_sp,
        default_chars: r && r.default_chars,
        default_source: r && r.default_source,
        default_source_name: r && r.default_source_name,
      });
    } catch {
      try {
        await this._view.webview.postMessage({
          type: "customSP",
          action: "get",
          has_custom: false,
        });
      } catch {}
    }
  }

  async _handleSetCustomSP(msg) {
    if (!this._view) return;
    try {
      const r = await httpPostJson(
        `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
        { sp: msg.sp, keep_blocks: false, source: "webview" },
        3000,
      );
      await this._view.webview.postMessage({
        type: "customSP",
        action: "set",
        ok: r && r.ok,
        chars: r && r.chars,
        error: r && r.error,
      });
      if (r && r.ok) {
        this._lastSig = "";
        setTimeout(() => this.forceRefresh().catch(() => {}), 300);
      }
    } catch (e) {
      try {
        await this._view.webview.postMessage({
          type: "customSP",
          action: "set",
          ok: false,
          error: e.message,
        });
      } catch {}
    }
  }

  async _handleResetCustomSP() {
    if (!this._view) return;
    try {
      const r = await httpDelete(
        `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
        2000,
      );
      await this._view.webview.postMessage({
        type: "customSP",
        action: "reset",
        ok: r && r.ok,
      });
      if (r && r.ok) {
        this._lastSig = "";
        setTimeout(() => this.forceRefresh().catch(() => {}), 300);
      }
    } catch {
      try {
        await this._view.webview.postMessage({
          type: "customSP",
          action: "reset",
          ok: false,
        });
      } catch {}
    }
  }

  async _handleSetCanon(canon) {
    if (!this._view) return;
    // v10.3.1: 映射下拉框值 → 代理经文模式
    // "laozi+yinfu" → "full" | "laozi" → "laozi" | "yinfu" → "yinfu"
    const canonMap = { "laozi+yinfu": "full", laozi: "laozi", yinfu: "yinfu" };
    const proxyCanon = canonMap[canon] || canon || "full";
    try {
      const r = await httpPostJson(
        `http://127.0.0.1:${_cachedPort}/origin/canon`,
        { canon: proxyCanon },
        2000,
      );
      L.info("canon", `→ ${canon} (ok=${r && r.ok})`);
      this._lastSig = "";
      // 切经文即推新 default_sp
      try {
        const cs = await httpGetJson(
          `http://127.0.0.1:${_cachedPort}/origin/custom_sp`,
          2000,
        );
        if (cs && cs.ok && this._view) {
          await this._view.webview.postMessage({
            type: "canonChanged",
            canon: r && r.canon,
            canon_name: r && r.canon_name,
            chars: r && r.chars,
            default_sp: cs.default_sp,
            default_chars: cs.default_chars,
            default_source_name: cs.default_source_name,
            has_custom: cs.has_custom,
          });
        }
      } catch {}
      setTimeout(() => this.forceRefresh().catch(() => {}), 300);
    } catch (e) {
      L.warn("canon", `set fail: ${e.message}`);
    }
  }

  updatePort(newPort) {
    if (!this._view) return;
    if (newPort === _cachedPort) return;
    L.info("webview", `port changed: ${_cachedPort} → ${newPort}`);
    _cachedPort = newPort;
    if (this._sse) this._sse.setPort(newPort);
    const ssrSp = _loadSilkForWebview();
    this._view.webview.options = {
      enableScripts: true,
      portMapping: [{ webviewPort: newPort, extensionHostPort: newPort }],
    };
    this._view.webview.html = getEssenceHtml(
      newPort,
      null,
      ssrSp,
      this._view.webview,
      this._ctx.extensionUri,
    );
  }

  dispose() {
    this._stopTimer();
    try {
      if (this._sse) this._sse.stop();
    } catch {}
    this._sse = null;
    this._view = null;
  }
}

let _essenceProvider = null;

// ═══════════════════════════ icon SVG ═══════════════════════════
function ensureIconSvg() {
  const mediaDir = path.join(__dirname, "media");
  const svgPath = path.join(mediaDir, "icon.svg");
  if (!fs.existsSync(svgPath)) {
    try {
      if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
      fs.writeFileSync(
        svgPath,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10"/><path d="M12 2c2.5 3 4 7 4 10s-1.5 7-4 10"/><path d="M2 12h20"/></svg>`,
        "utf8",
      );
    } catch {}
  }
}

// ═══════════════════════════ activate ═══════════════════════════
function activate(ctx) {
  _activateTs = Date.now();
  try {
    cfg();
    _cachedAnchored = isAnchored();
    _cachedMode = vscode.workspace
      .getConfiguration("kiro.dao")
      .get("defaultMode", "invert");

    ensureIconSvg();
    L.info(
      "ext",
      `kiro-dao-agent v${PKG_VERSION} activate · port=${_cachedPort} anchored=${_cachedAnchored} user=${os.userInfo().username}`,
    );

    // v10.3: 清理无效 kiroAgent.modelSelection · 道法自然 · 不留残
    // 无效模型ID (如 deepseek-3.2, claude-opus-4.8) 导致模型选择面板空白
    // 删除后 Kiro 自动使用 defaultModel
    try {
      const modelSel = vscode.workspace
        .getConfiguration("kiroAgent")
        .get("modelSelection", "");
      if (modelSel && modelSel !== "") {
        // 已知无效模型ID列表 · 不在此列的保留
        const _INVALID_MODELS = [
          "deepseek-3.2",
          "claude-opus-4.8",
          "deepseek-v3",
          "claude-opus-4",
          "gpt-4o",
          "gpt-4",
        ];
        if (_INVALID_MODELS.includes(modelSel)) {
          L.info("activate", `清理无效 modelSelection: ${modelSel}`);
          vscode.workspace
            .getConfiguration("kiroAgent")
            .update(
              "modelSelection",
              undefined,
              vscode.ConfigurationTarget.Global,
            );
        }
      }
    } catch (e) {
      L.warn("activate", `modelSelection 清理失败: ${e.message}`);
    }

    // 道德经横幅
    if (vscode.workspace.getConfiguration("kiro.dao").get("banner", false)) {
      const q = DAO_QUOTES[Math.floor(Math.random() * DAO_QUOTES.length)];
      vscode.window.showInformationMessage(`道Agent v${PKG_VERSION} · ${q}`);
    }

    // 注册命令
    ctx.subscriptions.push(
      vscode.commands.registerCommand("kiro.dao.invert", cmdInvert),
      vscode.commands.registerCommand("kiro.dao.passthrough", cmdPassthrough),
      vscode.commands.registerCommand("kiro.dao.toggleMode", cmdToggle),
      vscode.commands.registerCommand("kiro.dao.openPreview", cmdOpenPreview),
      vscode.commands.registerCommand("kiro.dao.selftest", cmdSelftest),
      vscode.commands.registerCommand(
        "kiro.dao.verifyEndToEnd",
        cmdVerifyEndToEnd,
      ),
      vscode.commands.registerCommand("kiro.dao.term.exec", cmdTermExec),
      vscode.commands.registerCommand("kiro.dao.term.list", cmdTermList),
      vscode.commands.registerCommand("kiro.dao.term.close", cmdTermClose),
    );

    // ═══ 本源观照 · webview provider 注册 ═══
    // 道义: 三十二章 "道恒无名 · 侯王若能守之 · 万物将自宾"
    _essenceProvider = new EssenceProvider(ctx);
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "dao.essence",
        _essenceProvider,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
    L.info("ext", "EssenceProvider registered · dao.essence");

    // 自 focus dao-container · 强制 resolveWebviewView 触发 · SSR 帛书立现
    // 三十七章: 道恒无名 · 侯王若能守之 · 万物将自化
    // 首装 / 重装 / 更新后 · 侧栏可能默 collapse · 一focus即开
    setTimeout(() => {
      try {
        vscode.commands.executeCommand(
          "workbench.view.extension.dao-container",
        );
        L.info("activate", "focus dao-container · webview 自化");
      } catch (e) {
        L.warn("activate", `focus fail: ${e.message}`);
      }
    }, 5000);

    // v11: 太上不知有之 · 立即锚定 + 确保代理运行 · 无需重启Kiro
    // 道义: 第十七章「太上, 不知有之; 其次, 亲而誉之」
    // 代理独立于Kiro进程 · 重启不灭 · 锚定永存
    (async () => {
      try {
        // 1. 立即写锚 (不管是否已锚 · 确保最新)
        await setAnchor(_cachedPort);
        _cachedAnchored = true;
        _cachedProxyUrl = `http://127.0.0.1:${_cachedPort}`;
        L.info("activate", `anchor written immediately :${_cachedPort}`);

        // 2. 确保代理运行 (已在则用, 不在则启)
        const alive = await proxyEnsure(_cachedPort, _cachedMode || "invert");
        if (alive) {
          proxySetMode(_cachedMode || "invert");
          L.info(
            "activate",
            `proxy ensured · mode=${_cachedMode} :${_cachedPort}`,
          );
        } else {
          L.warn(
            "activate",
            `proxy ensure failed :${_cachedPort} · watchdog will retry`,
          );
        }
      } catch (e) {
        L.error(
          "activate",
          `auto-start fail: ${e.message} · watchdog will retry`,
        );
      }
    })();

    // v11: watchdog · 15s 自愈 · 太上不知有之
    // 道义: 五十一章「道生之 · 德畜之 · 长之育之 · 亭之毒之 · 养之覆之」
    // 每 15s 自检 proxy 活否; 死则起之 · 锚失则补之 · 不假外求
    const watchdogId = setInterval(async () => {
      try {
        if (Date.now() - _activateTs < 10000) return; // 渡过启动危窗 · 10s
        const port = _cachedPort;

        // 1. 检锚 · 失则补
        if (!isAnchored()) {
          L.warn("watchdog", "anchor lost → re-anchoring");
          await setAnchor(port);
          _cachedAnchored = true;
        }

        // 2. 检代理 · 死则复生
        const ping = await httpGetJson(
          `http://127.0.0.1:${port}/origin/ping`,
          2000,
        ).catch(() => null);
        if (ping && ping.ok) {
          // 活 · 安心
          _cachedMode = ping.mode || _cachedMode;
          return;
        }

        // 3. 代理亡 → 复生
        L.warn("watchdog", `proxy dead :${port} → respawning`);
        const alive = await proxyEnsure(port, _cachedMode || "invert");
        if (alive) {
          proxySetMode(_cachedMode || "invert");
          L.info("watchdog", "proxy 复活");
        } else {
          L.error("watchdog", `proxy respawn failed :${port}`);
        }
      } catch (e) {
        L.error("watchdog", `tick err: ${e.message}`);
      }
    }, 15000);
    ctx.subscriptions.push({ dispose: () => clearInterval(watchdogId) });
    L.info("activate", "watchdog 启 · 15s 自愈一周");

    // 终端会话池 · 10s 延迟
    setTimeout(() => {
      try {
        _startDaoTermService(ctx);
      } catch (e) {
        L.warn("term", `term service start fail: ${e.message}`);
      }
    }, 10000);
  } catch (e) {
    L.error("activate", `FATAL: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`道Agent 激活失败: ${e.message}`);
  }
}

// ═══════════════════════════ deactivate ═══════════════════════════
// v11: 太上不知有之 · 不停代理 · 不清锚 · 代理独立于Kiro进程
// 道义: 第十七章「功成事遂, 百姓皆谓我自然」
async function deactivate() {
  L.info("ext", "deactivate · v11: 不停代理 · 不清锚 · 代理自化");

  // 不清锚 · 不停代理 · 代理是独立进程 · 不随Kiro亡
  // 下次Kiro启动 → activate → anchor仍在 → proxy仍在 → 无缝衔接
  _cachedAnchored = false;

  if (_DAO_TERM_POOL) {
    _DAO_TERM_POOL.closeAll();
    _DAO_TERM_POOL = null;
  }
  if (_DAO_TERM_HTTP) {
    try {
      _DAO_TERM_HTTP.close();
    } catch {}
    _DAO_TERM_HTTP = null;
  }
  // 清理 SSE + EssenceProvider
  if (_essenceProvider) {
    try {
      _essenceProvider.dispose();
    } catch {}
    _essenceProvider = null;
  }

  // 不调用 proxyStop() · 代理继续运行
  L.info("deactivate", "proxy continues running · anchor preserved · 大道至简");
}

module.exports = { activate, deactivate };
