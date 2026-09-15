#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PROJECT_ROOT } = require("../core/project_paths.js");
const { readJsonFile, writeJsonAtomic } = require("../core/json_file.js");

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  }
  catch (error) {
    return error?.code === "EPERM";
  }
}

function markStaleManifest(directory) {
  const file = path.join(directory, "baseline_manifest.json");
  if (!fs.existsSync(file)) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
  if (!manifest || typeof manifest !== "object") return null;
  const rootStale = manifest.status === "running" && !processAlive(manifest.pid);
  let changed = false;
  if (rootStale) {
    manifest.status = "interrupted";
    manifest.interrupted_at = new Date().toISOString();
    manifest.interruption_reason = "runner process is no longer alive";
    changed = true;
  }
  for (const entry of Array.isArray(manifest.cases) ? manifest.cases : []) {
    if (entry.status !== "running") continue;
    const stale = entry.pid != null ? !processAlive(entry.pid) : rootStale;
    if (!stale) continue;
    entry.status = "interrupted";
    entry.interrupted_at = new Date().toISOString();
    entry.error ||= "baseline child process is no longer alive";
    changed = true;
  }
  if (changed) writeJsonAtomic(file, manifest);
  return changed ? manifest : null;
}

async function main(argv = process.argv.slice(2)) {
  const options = { "--seed": "1942", "--replicate": "1" };
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--out-dir", "--seed", "--replicate"].includes(argv[i]) || !argv[i + 1]) throw new Error(`invalid argument ${argv[i]}`);
    options[argv[i]] = argv[i + 1];
  }
  if (!options["--out-dir"]) throw new Error("--out-dir is required");
  for (const name of ["--seed", "--replicate"]) if (!Number.isInteger(Number(options[name]))) throw new Error(`${name} must be an integer`);
  const directory = path.resolve(options["--out-dir"]);
  if (fs.existsSync(directory)) {
    const stale = markStaleManifest(directory);
    if (stale) throw new Error("existing baseline directory was marked interrupted; use a new directory");
    throw new Error("use a new directory; baselines are never overwritten");
  }
  fs.mkdirSync(directory, { recursive: true });
  const manifest = { protocol: "rules-baseline-batch-v1", pid: process.pid, status: "running", seed: Number(options["--seed"]),
    replicate: Number(options["--replicate"]), paid_requests: false, cases: [] };
  const save = () => writeJsonAtomic(path.join(directory, "baseline_manifest.json"), manifest);
  let interrupted = false;
  let activeChild = null;
  let activeEntry = null;
  const handleSignal = (signal) => {
    interrupted = true;
    manifest.status = "interrupted";
    manifest.interrupted_at = new Date().toISOString();
    manifest.interruption_reason = `runner received ${signal}`;
    if (activeEntry) {
      activeEntry.status = "interrupted";
      activeEntry.interrupted_at = manifest.interrupted_at;
      activeEntry.error ||= `runner received ${signal}`;
    }
    save();
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
    else process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  save();
  for (const scenario of ["july", "september", "october"]) {
    if (interrupted) break;
    const output = path.join(directory, `${scenario}.json`);
    const args = ["ai/experiments/external_ai_full_game_transcript.js", "--scenario", scenario,
      "--axis-controller", "rules_ai", "--allies-controller", "rules_ai", "--decision-policy", "direct",
      "--task-management", "disabled", "--model-profile", "mock_primary", "--seed", options["--seed"],
      "--replicate", options["--replicate"], "--out", output];
    const consoleLog = path.join(directory, `${scenario}.console.log`);
    const entry = { scenario, output, console_log: consoleLog, args, status: "running" };
    manifest.cases.push(entry);
    save();
    const fd = fs.openSync(consoleLog, "w");
    try {
      const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ["ignore", fd, fd] });
      activeChild = child;
      activeEntry = entry;
      entry.pid = child.pid;
      save();
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      entry.exit_code = exit.code;
      entry.signal = exit.signal;
      if (interrupted) break;
      if (exit.code !== 0) throw new Error(`baseline process failed (code=${exit.code}, signal=${exit.signal}); see ${consoleLog}`);
      if (!fs.existsSync(output)) throw new Error(`baseline process produced no transcript; see ${consoleLog}`);
      const run = await readJsonFile(output);
      entry.final_vp = run.summary?.victory?.victory_points;
      entry.status = run.status === "final_victory" && run.counts?.illegal_actions === 0 ? "completed" : "failed";
      entry.artifact_hash = run.artifact_manifest_hash;
    } catch (error) {
      if (!interrupted) { entry.status = "failed"; entry.error = error.message; }
    }
    finally {
      activeChild = null;
      activeEntry = null;
      fs.closeSync(fd);
      save();
    }
  }
  if (!interrupted) manifest.status = manifest.cases.every((entry) => entry.status === "completed") ? "completed" : "failed";
  save();
  process.removeListener("SIGINT", handleSignal);
  process.removeListener("SIGTERM", handleSignal);
  console.log(JSON.stringify({ manifest: path.join(directory, "baseline_manifest.json"), status: manifest.status }));
  if (manifest.status !== "completed") process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, markStaleManifest, processAlive };
