#!/usr/bin/env node
// 冷启动登录态注入 · Cold-start auth injector
// 用导出的 accounts_*.json（含 clientId/clientSecret/refreshToken/region）刷新出
// 一个鲜活 accessToken，并写入 Kiro 读取的 token 缓存，免去 GUI 手动登录。
//
// 用法:  node scripts/inject-auth.js <accounts.json> [--email someone@x.com]
//
// 不路由任何第三方：仅调用 AWS 官方 OIDC (oidc.<region>.amazonaws.com/token)。
// 不在仓库内写入任何密钥；凭证来自外部 accounts 文件。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

function die(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

function postJson(host, p, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = https.request(
      {
        host,
        path: p,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": data.length,
        },
        timeout: 30000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: buf }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(data);
    req.end();
  });
}

(async () => {
  const args = process.argv.slice(2);
  const accountsPath = args.find((a) => !a.startsWith("--"));
  if (!accountsPath) die("usage: node scripts/inject-auth.js <accounts.json> [--email x]");
  const emailIdx = args.indexOf("--email");
  const wantEmail = emailIdx >= 0 ? args[emailIdx + 1] : null;

  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
  } catch (e) {
    die("cannot read/parse accounts file: " + e.message);
  }
  if (!Array.isArray(arr)) arr = [arr];
  const acc = wantEmail ? arr.find((a) => a.email === wantEmail) : arr[0];
  if (!acc) die("no matching account in file");
  for (const k of ["clientId", "clientSecret", "refreshToken", "region"]) {
    if (!acc[k]) die("account missing field: " + k);
  }
  console.log(`account: ${acc.email || "(no email)"}  provider=${acc.provider || "?"}  region=${acc.region}`);

  const oidcHost = `oidc.${acc.region}.amazonaws.com`;
  const resp = await postJson(oidcHost, "/token", {
    clientId: acc.clientId,
    clientSecret: acc.clientSecret,
    grantType: "refresh_token",
    refreshToken: acc.refreshToken,
  });
  if (resp.status !== 200) die(`OIDC refresh failed ${resp.status}: ${resp.body.slice(0, 300)}`);
  const tok = JSON.parse(resp.body);
  const accessToken = tok.accessToken;
  const refreshToken = tok.refreshToken || acc.refreshToken;
  const expiresAt = new Date(Date.now() + (tok.expiresIn || 3600) * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");

  const cacheDir = path.join(os.homedir(), ".aws", "sso", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = {
    accessToken,
    refreshToken,
    expiresAt,
    region: acc.region,
    startUrl: "https://view.awsapps.com/start",
    clientId: acc.clientId,
    clientSecret: acc.clientSecret,
    provider: acc.provider || "BuilderId",
    authMethod: "BuilderId",
    clientIdHash: crypto.createHash("sha256").update(acc.clientId).digest("hex"),
    ssoRegion: acc.region,
    scopes: ["codewhisperer:completions", "codewhisperer:analysis"],
  };
  const tokenPath = path.join(cacheDir, "kiro-auth-token.json");
  fs.writeFileSync(tokenPath, JSON.stringify(cache, null, 2));

  const regName =
    crypto.createHash("sha1").update("kiro-builder-id").digest("hex") + ".json";
  fs.writeFileSync(
    path.join(cacheDir, regName),
    JSON.stringify(
      {
        clientId: acc.clientId,
        clientSecret: acc.clientSecret,
        scopes: cache.scopes,
        region: acc.region,
      },
      null,
      2,
    ),
  );

  console.log("wrote " + tokenPath);
  console.log("expiresAt " + expiresAt);
  console.log("OK — launch Kiro; it should be logged in (verify via usage counter).");
})().catch((e) => die(e.message));
