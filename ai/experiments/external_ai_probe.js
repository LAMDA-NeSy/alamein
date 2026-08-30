#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { PROJECT_ROOT } = require("../core/project_paths.js");

const ROOT = PROJECT_ROOT;
const REAL_CHECK = path.join(__dirname, "external_ai_real_check.js");
const NODE = process.execPath;

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const input = await readStdin();
  const result = spawnSync(NODE, [REAL_CHECK, ...process.argv.slice(2)], {
    cwd: ROOT,
    encoding: "utf8",
    input
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(JSON.stringify({ error: result.error.message }, null, 2));
    process.exit(1);
    return;
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error.message,
    hint: `external_ai_probe.js is a compatibility wrapper for ${REAL_CHECK}`
  }, null, 2));
  process.exit(1);
});
