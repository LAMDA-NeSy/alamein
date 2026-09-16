#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readConfigFile } = require("../core/config_file.js");
const { createModelRuntime, closeModelRuntime, resolveModel } = require("../core/model_runtime.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");

const DEFAULT_CONFIG = path.join(PROJECT_ROOT, "ai", "config", "model_suites.yaml");

function integer(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return number;
}

function safeId(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9_-]+/g, "_") || "model";
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { config: DEFAULT_CONFIG, concurrency: 1, caseConcurrency: 1, dryRun: false, background: false, status: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--background") options.background = true;
    else if (arg === "--config") options.config = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--concurrency") options.concurrency = integer(argv[++index], "--concurrency");
    else if (arg === "--case-concurrency") options.caseConcurrency = integer(argv[++index], "--case-concurrency");
    else if (arg === "--status") options.status = argv[++index];
    else if (arg === "--models") options.models = String(argv[++index]).split(",").map((value) => value.trim()).filter(Boolean);
    else if (arg === "--") continue;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.status && !options.outDir) throw new Error("--out-dir is required");
  return options;
}

function loadSuite(configFile, requestedModels) {
  const document = readConfigFile(path.resolve(configFile));
  if (Number(document.version || 0) !== 1) throw new Error("model suite config version must be 1");
  if (!Array.isArray(document.models) || !document.models.length) throw new Error("model suite config must contain a non-empty models list");
  const selected = requestedModels?.length
    ? document.models.filter((entry) => requestedModels.includes(entry.id))
    : document.models;
  if (!selected.length) throw new Error("no requested model ids exist in the suite config");
  const ids = new Set();
  return selected.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.model_profile || !entry.checker_model_profile) {
      throw new Error("each suite model requires model_profile and checker_model_profile");
    }
    const id = safeId(entry.id || entry.model_profile);
    if (ids.has(id)) throw new Error(`duplicate suite model id ${id}`);
    ids.add(id);
    return { id, model_profile: String(entry.model_profile), checker_model_profile: String(entry.checker_model_profile) };
  });
}

function readManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function saveManifest(file, manifest) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(manifest, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function childArgs(entry, directory, caseConcurrency) {
  return [
    path.join(PROJECT_ROOT, "ai", "experiments", "run_sae_acceptance.js"),
    "--out-dir", directory,
    "--model-profile", entry.model_profile,
    "--task-checker-model-profile", entry.checker_model_profile,
    "--concurrency", String(caseConcurrency)
  ];
}

async function validateProfiles(entries) {
  for (const entry of entries) {
    for (const profileId of [entry.model_profile, entry.checker_model_profile]) {
      const runtime = createModelRuntime(resolveModel(profileId));
      await closeModelRuntime(runtime);
    }
  }
}

function status(options) {
  const file = path.join(path.resolve(options.status), "suite_manifest.json");
  const manifest = readManifest(file);
  if (!manifest) throw new Error(`suite manifest not found: ${file}`);
  const live = manifest.children.filter((entry) => entry.status === "running").map((entry) => ({ id: entry.id, pid: entry.pid, alive: processAlive(entry.pid) }));
  process.stdout.write(`${JSON.stringify({ ...manifest, live }, null, 2)}\n`);
}

function launchBackground(argv) {
  const filtered = argv.filter((arg) => arg !== "--background");
  const directory = path.resolve(filtered[filtered.indexOf("--out-dir") + 1]);
  fs.mkdirSync(directory, { recursive: true });
  const log = fs.openSync(path.join(directory, "suite.console.log"), "a");
  const child = spawn(process.execPath, [__filename, ...filtered], {
    cwd: PROJECT_ROOT, detached: true, env: process.env, stdio: ["ignore", log, log]
  });
  child.unref();
  fs.closeSync(log);
  process.stdout.write(`${JSON.stringify({ out_dir: directory, pid: child.pid, status: "started_in_background" })}\n`);
}

async function runSuite(options, entries) {
  const directory = path.resolve(options.outDir);
  const manifestFile = path.join(directory, "suite_manifest.json");
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(manifestFile)) throw new Error(`suite already exists: ${manifestFile}; choose a new --out-dir`);
  const children = entries.map((entry) => ({ ...entry, status: "pending", pid: null, batch_dir: path.join(directory, entry.id) }));
  const manifest = {
    protocol: "sae-model-suite-v1", status: "running", pid: process.pid,
    started_at: new Date().toISOString(), config: path.resolve(options.config),
    concurrency: options.concurrency, case_concurrency: options.caseConcurrency,
    children
  };
  const save = () => saveManifest(manifestFile, manifest);
  save();
  let interrupted = false;
  const active = new Map();
  const stop = (signal) => {
    if (interrupted) return;
    interrupted = true;
    manifest.status = "interrupted";
    manifest.interrupted_at = new Date().toISOString();
    manifest.interruption_reason = `suite received ${signal}`;
    for (const [entry, child] of active) {
      entry.status = "interrupted"; entry.signal = signal;
      try { child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM"); } catch {}
    }
    save();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => { manifest.last_signal = "SIGHUP"; manifest.session_hangup_ignored = true; save(); });
  let cursor = 0;
  async function worker() {
    while (!interrupted) {
      const entry = children[cursor++];
      if (!entry) return;
      let output;
      try {
        entry.status = "running"; entry.started_at = new Date().toISOString();
        fs.mkdirSync(entry.batch_dir, { recursive: true });
        output = fs.openSync(path.join(entry.batch_dir, "launcher.console.log"), "a");
        const child = spawn(process.execPath, childArgs(entry, entry.batch_dir, options.caseConcurrency), {
          cwd: PROJECT_ROOT, env: process.env, detached: true, stdio: ["ignore", output, output]
        });
        fs.closeSync(output); output = null;
        entry.pid = child.pid; active.set(entry, child); save();
        const outcome = await new Promise((resolve) => {
          child.once("error", (error) => resolve({ code: 1, error: error.message }));
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        active.delete(entry); entry.finished_at = new Date().toISOString();
        entry.exit_code = outcome.code; entry.signal = outcome.signal || null; entry.error = outcome.error || null;
        entry.status = interrupted ? "interrupted" : outcome.code === 0 ? "completed" : "failed";
      }
      catch (error) {
        if (output != null) fs.closeSync(output);
        active.delete(entry); entry.finished_at = new Date().toISOString();
        entry.status = interrupted ? "interrupted" : "failed";
        entry.error = error.message;
      }
      save();
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, children.length) }, () => worker()));
  manifest.status = interrupted ? "interrupted" : children.every((entry) => entry.status === "completed") ? "completed" : "completed_with_errors";
  manifest.finished_at = new Date().toISOString();
  save();
  process.stdout.write(`${JSON.stringify({ manifest: manifestFile, status: manifest.status })}\n`);
  if (manifest.status !== "completed") process.exitCode = 1;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.status) return status(options);
  if (options.background) return launchBackground(argv);
  const entries = loadSuite(options.config, options.models);
  await validateProfiles(entries);
  const preview = entries.map((entry) => ({ ...entry, case_concurrency: options.caseConcurrency }));
  if (options.dryRun) return process.stdout.write(`${JSON.stringify({ config: path.resolve(options.config), concurrency: options.concurrency, models: preview }, null, 2)}\n`);
  return runSuite(options, entries);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { loadSuite, parseArgs, processAlive };
