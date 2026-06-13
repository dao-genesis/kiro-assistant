// ═══════════════════════════════════════════════════════════════════════════
// _upstream_relay.js — 独立 Node.js 上游 HTTPS 中继
// ═══════════════════════════════════════════════════════════════════════════
// 运行在 Electron 外部 (child_process.fork)，不受 Chromium 网络栈劫持
// 通过 IPC 消息接收请求，直连 AWS Q Service，返回响应
//
// 协议:
//   父进程 → relay:  { type:'request', id, method, hostname, port, path, headers, bodyBase64 }
//   relay → 父进程:  { type:'response', id, statusCode, headers, bodyBase64 }
//   relay → 父进程:  { type:'error', id, message }
//   relay → 父进程:  { type:'stream-chunk', id, chunkBase64 }
//   relay → 父进程:  { type:'stream-end', id }
//   父进程 → relay:  { type:'ping' }
//   relay → 父进程:  { type:'pong' }

const https = require("https");
const zlib = require("zlib");

// v17: 代理环境变量策略 — 由父进程根据DAO_PROXY_MODE决定
// 父进程已设置好环境变量，子进程直接继承即可
// 不再强制删除代理变量 — 国内用户需要VPN访问AWS Q

let _requestCount = 0;

process.on("message", (msg) => {
  if (msg.type === "ping") {
    process.send({ type: "pong", pid: process.pid });
    return;
  }
  if (msg.type === "request") {
    handleRequest(msg);
    return;
  }
});

function handleRequest(msg) {
  const { id, method, hostname, port, path, headers, bodyBase64, streamMode } = msg;
  const body = bodyBase64 ? Buffer.from(bodyBase64, "base64") : null;

  const opts = {
    hostname,
    port: port || 443,
    path,
    method,
    headers: headers || {},
    // 不设 agent — 使用 Node.js 默认 HTTPS Agent (不受 Chromium 劫持)
    // v17: Node.js 默认Agent会读取环境变量中的代理设置 → 走用户VPN
  };

  // 如果有 body，设置 content-length
  if (body && !opts.headers["content-length"]) {
    opts.headers["content-length"] = body.length;
  }

  const req = https.request(opts, (res) => {
    if (streamMode) {
      // 流式模式: 逐 chunk 发送
      process.send({
        type: "stream-start",
        id,
        statusCode: res.statusCode,
        headers: res.headers,
      });
      res.on("data", (chunk) => {
        process.send({
          type: "stream-chunk",
          id,
          chunkBase64: chunk.toString("base64"),
        });
      });
      res.on("end", () => {
        process.send({ type: "stream-end", id });
      });
    } else {
      // 缓冲模式: 收集完整响应后发送
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        // 尝试解压 gzip/deflate
        const encoding = (res.headers["content-encoding"] || "").toLowerCase();
        if (encoding === "gzip") {
          zlib.gunzip(rawBuf, (err, decoded) => {
            process.send({
              type: "response",
              id,
              statusCode: res.statusCode,
              headers: res.headers,
              bodyBase64: (err ? rawBuf : decoded).toString("base64"),
            });
          });
        } else if (encoding === "deflate") {
          zlib.inflate(rawBuf, (err, decoded) => {
            process.send({
              type: "response",
              id,
              statusCode: res.statusCode,
              headers: res.headers,
              bodyBase64: (err ? rawBuf : decoded).toString("base64"),
            });
          });
        } else {
          process.send({
            type: "response",
            id,
            statusCode: res.statusCode,
            headers: res.headers,
            bodyBase64: rawBuf.toString("base64"),
          });
        }
      });
    }
  });

  req.on("error", (e) => {
    process.send({ type: "error", id, message: e.message, code: e.code });
  });

  req.setTimeout(30000, () => {
    req.destroy(new Error("upstream timeout 30s"));
  });

  if (body) req.write(body);
  req.end();
}

// 通知父进程就绪
process.send({ type: "ready", pid: process.pid });
