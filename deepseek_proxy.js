#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);

function readConfig() {
  const source = fs.readFileSync(path.join(ROOT, "ai_config.js"), "utf8");
  const context = { globalThis: {} };
  context.globalThis.globalThis = context.globalThis;
  vm.runInNewContext(source, context, { filename: "ai_config.js" });
  return context.globalThis.ALAMEIN_AI_CONFIG;
}

function readLocalEnv() {
  const envFile = path.join(ROOT, ".env");
  try {
    const result = {};
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      result[key] = value;
    }
    return result;
  }
  catch {
    return {};
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleChat(req, res, config) {
  const apiKey = process.env.DEEPSEEK_API_KEY || readLocalEnv().DEEPSEEK_API_KEY;
  if (!apiKey) {
    writeJson(res, 500, { error: "DEEPSEEK_API_KEY is required in the proxy environment" });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  }
  catch (error) {
    writeJson(res, 400, { error: `invalid JSON request: ${error.message}` });
    return;
  }

  const api = config.api || {};
  payload.model ||= api.model;
  payload.temperature ??= api.temperature ?? 0.25;
  payload.max_tokens ??= api.maxTokens || 2200;
  payload.response_format ||= api.responseFormat || { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(api.timeoutSeconds || 30) * 1000);
  try {
    const upstream = await fetch(api.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": upstream.headers.get("content-type") || "application/json"
    });
    res.end(text);
  }
  catch (error) {
    writeJson(res, 502, { error: error.name === "AbortError" ? "DeepSeek request timed out" : error.message });
  }
  finally {
    clearTimeout(timer);
  }
}

function main() {
  const config = readConfig();
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      writeJson(res, 204, {});
      return;
    }
    if (req.method === "POST" && req.url === "/chat/completions") {
      handleChat(req, res, config);
      return;
    }
    writeJson(res, 404, { error: "not found" });
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`DeepSeek proxy listening on http://127.0.0.1:${PORT}/chat/completions`);
  });
}

main();
