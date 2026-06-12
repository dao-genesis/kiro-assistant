"use strict";
// ═══════════════════════════════════════════════════════════════════════════
// 道·第三方真隔离 (_dao_thirdparty.js)
// ───────────────────────────────────────────────────────────────────────────
// 反者道之动。客户端无法阻止 AWS Q 服务端注入 Kiro 身份——故"绝圣弃智"，
// 不与之争：将 generateAssistantResponse 整体改道至第三方 OpenAI 兼容模型，
// 系统提示词只放《老子》《阴符经》+ 必要工具，从根上无任何官方提示词。
//
// 职责:
//   1. 将 AWS Q (codewhisperer-streaming) 的 conversationState 翻译为 OpenAI 消息
//   2. 将 AWS Q 工具规格翻译为 OpenAI function 工具
//   3. 调用第三方模型 (Deepseek 等, OpenAI /chat/completions 协议)
//   4. 将模型回复 (文本 / tool_calls) 翻译回 AWS Q Smithy Event Stream 二进制帧
//      —— Kiro 客户端按原生 assistantResponseEvent / toolUseEvent 解析, 无感
// ═══════════════════════════════════════════════════════════════════════════
const https = require("https");
const { URL } = require("url");

// ── CRC32 (与主代理同一多项式) ──
const _crc32Table = (() => {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function _crc32(buf, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++)
    crc = _crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── 构建单个 Smithy Event Stream 帧 ──
// 帧结构: [totalLen u32][headersLen u32][preludeCrc u32] headers payload [msgCrc u32]
// header:  [nameLen u8][name][valueType=7 u8][valueLen u16][value]
function _buildFrame(eventType, payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const hdrParts = [];
  const addHeader = (name, value) => {
    const nameBuf = Buffer.from(name, "utf8");
    const valBuf = Buffer.from(value, "utf8");
    const b = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
    let o = 0;
    b.writeUInt8(nameBuf.length, o);
    o += 1;
    nameBuf.copy(b, o);
    o += nameBuf.length;
    b.writeUInt8(7, o);
    o += 1; // 7 = string
    b.writeUInt16BE(valBuf.length, o);
    o += 2;
    valBuf.copy(b, o);
    hdrParts.push(b);
  };
  addHeader(":event-type", eventType);
  addHeader(":content-type", "application/json");
  addHeader(":message-type", "event");
  const headers = Buffer.concat(hdrParts);
  const totalLen = 12 + headers.length + payload.length + 4;
  const frame = Buffer.alloc(totalLen);
  frame.writeUInt32BE(totalLen, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(_crc32(frame, 0, 8), 8);
  headers.copy(frame, 12);
  payload.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(_crc32(frame, 0, totalLen - 4), totalLen - 4);
  return frame;
}

// ── 将模型回复编码为 AWS Q Event Stream ──
//   text     → assistantResponseEvent {content, modelId}
//   toolCalls→ toolUseEvent {name,toolUseId} · {input,...} · {name,stop:true,toolUseId}
//   末尾      → contextUsageEvent + meteringEvent
function buildEventStream(result, opts) {
  opts = opts || {};
  const modelId = opts.modelId || "dao";
  const usagePct =
    typeof opts.usagePct === "number" ? opts.usagePct : 5.0;
  const credit = typeof opts.credit === "number" ? opts.credit : 0.1;
  const frames = [];

  const text = result.text || "";
  if (text) {
    // 分块发送, 模拟流式 (每块约 120 字)
    const CHUNK = 120;
    if (text.length <= CHUNK) {
      frames.push(_buildFrame("assistantResponseEvent", { content: text, modelId }));
    } else {
      for (let i = 0; i < text.length; i += CHUNK) {
        frames.push(
          _buildFrame("assistantResponseEvent", {
            content: text.slice(i, i + CHUNK),
            modelId,
          }),
        );
      }
    }
  }

  const toolCalls = result.toolCalls || [];
  for (const tc of toolCalls) {
    const toolUseId = tc.id || "tooluse_" + Math.random().toString(36).slice(2);
    const name = tc.function ? tc.function.name : tc.name;
    let args = tc.function ? tc.function.arguments : tc.input;
    if (typeof args !== "string") args = JSON.stringify(args || {});
    if (!args) args = "{}";
    frames.push(_buildFrame("toolUseEvent", { name, toolUseId }));
    frames.push(_buildFrame("toolUseEvent", { input: args, name, toolUseId }));
    frames.push(_buildFrame("toolUseEvent", { name, stop: true, toolUseId }));
  }

  frames.push(
    _buildFrame("contextUsageEvent", { contextUsagePercentage: usagePct }),
  );
  frames.push(
    _buildFrame("meteringEvent", {
      unit: "credit",
      unitPlural: "credits",
      usage: credit,
    }),
  );
  return Buffer.concat(frames);
}

// ── 提取 toolResult 内容为纯文本 ──
function _toolResultText(tr) {
  if (!tr) return "";
  if (Array.isArray(tr.content)) {
    return tr.content
      .map((c) => {
        if (c == null) return "";
        if (typeof c.text === "string") return c.text;
        if (c.json !== undefined) return JSON.stringify(c.json);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof tr.content === "string") return tr.content;
  return "";
}

// ── 判断一段文本是否官方 Kiro 系统提示词 (需丢弃) ──
function _looksLikeKiroSP(content) {
  if (typeof content !== "string") return false;
  if (content.startsWith("你是Kiro") || content.startsWith("你本無名"))
    return true; // 已注入的道SP — 也丢弃, 由本模块统一供SP
  if (/You are Kiro/i.test(content)) return true;
  if (content.includes("Task Execution Orchestrator")) return true;
  if (content.includes("ORCHESTRATOR MODE")) return true;
  if (content.includes("spec-task-execution")) return true;
  if (content.includes("Machine ID:")) return true;
  return false;
}

// ── AWS Q conversationState → OpenAI messages + tools ──
function awsQToOpenAI(cs, systemPrompt) {
  const messages = [{ role: "system", content: systemPrompt }];

  const pushUserOrTools = (uim) => {
    if (!uim) return;
    const ctx = uim.userInputMessageContext || {};
    const results = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    for (const tr of results) {
      messages.push({
        role: "tool",
        tool_call_id: tr.toolUseId,
        content: _toolResultText(tr) || (tr.status || "ok"),
      });
    }
    const text = (uim.content || "").trim();
    if (text && !_looksLikeKiroSP(uim.content)) {
      messages.push({ role: "user", content: uim.content });
    }
  };

  const pushAssistant = (arm) => {
    if (!arm) return;
    const msg = { role: "assistant", content: arm.content || "" };
    const toolUses = Array.isArray(arm.toolUses) ? arm.toolUses : [];
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((tu) => ({
        id: tu.toolUseId,
        type: "function",
        function: {
          name: tu.name,
          arguments:
            typeof tu.input === "string"
              ? tu.input
              : JSON.stringify(tu.input || {}),
        },
      }));
      if (!msg.content) msg.content = null;
    }
    // 跳过空填充 (无内容且无工具调用)
    if (!msg.content && !msg.tool_calls) return;
    messages.push(msg);
  };

  const hist = Array.isArray(cs.history) ? cs.history : [];
  for (const item of hist) {
    if (item.userInputMessage) pushUserOrTools(item.userInputMessage);
    else if (item.assistantResponseMessage)
      pushAssistant(item.assistantResponseMessage);
  }
  if (cs.currentMessage && cs.currentMessage.userInputMessage)
    pushUserOrTools(cs.currentMessage.userInputMessage);

  // ── 修复 OpenAI 配对约束 ──
  const repaired = _repairMessages(messages);

  // ── 工具规格翻译 ──
  let tools = [];
  const qTools =
    cs.currentMessage &&
    cs.currentMessage.userInputMessage &&
    cs.currentMessage.userInputMessage.userInputMessageContext
      ? cs.currentMessage.userInputMessage.userInputMessageContext.tools
      : null;
  if (Array.isArray(qTools)) {
    tools = qTools
      .map((t) => t.toolSpecification)
      .filter(Boolean)
      .map((spec) => ({
        type: "function",
        function: {
          name: spec.name,
          description: spec.description || "",
          parameters:
            (spec.inputSchema && spec.inputSchema.json) || {
              type: "object",
              properties: {},
            },
        },
      }));
  }

  return { messages: repaired, tools };
}

// ── 修复消息序列以满足 OpenAI 约束 ──
// 1. tool 消息必须紧跟在带相同 tool_call_id 的 assistant 之后
// 2. 带 tool_calls 的 assistant 之后必须有对应全部 id 的 tool 消息, 否则降级
// 3. 首条非 system 消息不能是 assistant (Deepseek 容忍, 但仍尽量保证)
function _repairMessages(messages) {
  const out = [];
  let pendingToolIds = null; // Set of tool_call_ids awaiting tool replies
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // 只有在前一条 assistant 声明了该 id 时才保留
      if (pendingToolIds && pendingToolIds.has(m.tool_call_id)) {
        out.push(m);
        pendingToolIds.delete(m.tool_call_id);
        if (pendingToolIds.size === 0) pendingToolIds = null;
      } else {
        // 孤立 tool 结果 → 降级为 user 文本, 避免 400
        if (m.content)
          out.push({
            role: "user",
            content: "[tool result] " + m.content,
          });
      }
      continue;
    }
    // 进入非 tool 消息前, 若仍有未回复的 tool_calls → 移除该 assistant 的 tool_calls
    if (pendingToolIds && pendingToolIds.size > 0) {
      const prev = out[out.length - 1];
      if (prev && prev.role === "assistant" && prev.tool_calls) {
        delete prev.tool_calls;
        if (!prev.content) prev.content = "(思而未发)";
      }
      pendingToolIds = null;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
      out.push(m);
      pendingToolIds = new Set(m.tool_calls.map((tc) => tc.id));
    } else {
      out.push(m);
    }
  }
  // 收尾: 末条 assistant 仍有未回复 tool_calls
  if (pendingToolIds && pendingToolIds.size > 0) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "assistant" && prev.tool_calls) {
      delete prev.tool_calls;
      if (!prev.content) prev.content = "(思而未发)";
    }
  }
  return out;
}

// ── 调用第三方 OpenAI 兼容模型 (非流式, 缓冲返回) ──
function callThirdParty(config, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.endpoint);
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + config.apiKey,
        "content-length": String(data.length),
        accept: "application/json",
      },
      timeout: 120000,
    };
    if (config.agent) options.agent = config.agent;
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) {
          reject(
            new Error(
              "thirdparty " + res.statusCode + ": " + bodyText.slice(0, 400),
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(bodyText));
        } catch (e) {
          reject(new Error("thirdparty parse: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("thirdparty timeout")));
    req.write(data);
    req.end();
  });
}

// ── 顶层编排: 处理一次 generateAssistantResponse 改道 ──
// 返回 Promise<Buffer> (已编码的 Event Stream) 或抛错
async function handleGenerate(cs, systemPrompt, config) {
  const { messages, tools } = awsQToOpenAI(cs, systemPrompt);
  const payload = {
    model: config.model,
    messages,
    stream: false,
    max_tokens: config.maxTokens || 4096,
    temperature:
      typeof config.temperature === "number" ? config.temperature : 0.7,
  };
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }
  const resp = await callThirdParty(config, payload);
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const result = {
    text: msg.content || "",
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
  };
  const usage = resp.usage || {};
  const credit = usage.total_tokens ? usage.total_tokens / 100000 : 0.1;
  return {
    stream: buildEventStream(result, { modelId: config.model, credit }),
    meta: {
      msgCount: messages.length,
      toolCount: tools.length,
      replyChars: result.text.length,
      replyTools: result.toolCalls.length,
      finish: choice.finish_reason,
    },
  };
}

module.exports = {
  buildEventStream,
  awsQToOpenAI,
  callThirdParty,
  handleGenerate,
  _buildFrame,
  _repairMessages,
};
