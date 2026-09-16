#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildExperimentJobs } = require("./run_ai_experiments.js");
const { createModelRuntime, closeModelRuntime } = require("../core/model_runtime.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");
const { readJsonFile } = require("../core/json_file.js");
const { validateArtifactManifest } = require("../core/benchmark_artifacts.js");

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

function terminateProcessGroup(pid, signal = "SIGTERM") {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-Number(pid), signal);
      return true;
    }
    catch {}
  }
  try {
    process.kill(Number(pid), signal);
    return true;
  }
  catch {
    return false;
  }
}

function readManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }
  catch {
    return null;
  }
}

function markStaleManifest(directory) {
  const manifestPath = path.join(directory, "batch_manifest.json");
  const manifest = readManifest(manifestPath);
  if (!manifest) return null;
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
    // A dead launcher makes a child orphaned even when its PID is still alive.
    // Do not kill an unowned PID here: the operating system may have reused it.
    const stale = rootStale || (entry.pid != null ? !processAlive(entry.pid) : false);
    if (!stale) continue;
    entry.status = "interrupted";
    entry.interrupted_at = manifest.interrupted_at || new Date().toISOString();
    entry.error ||= rootStale && entry.pid != null && processAlive(entry.pid)
      ? "launcher is gone; child PID may be orphaned and was not terminated automatically"
      : "acceptance child process is no longer alive";
    if (rootStale && entry.pid != null && processAlive(entry.pid)) entry.orphaned_pid = entry.pid;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  }
  return changed ? manifest : null;
}

function validateAcceptanceResult(result) {
  const reasons = [];
  if (result.status !== "final_victory" || result.summary?.victory?.final !== true) reasons.push("game_not_complete");
  if (result.counts?.illegal_actions !== 0) reasons.push("application_illegal_actions_or_missing_count");
  if (result.context_store_errors?.length) reasons.push("context_store_errors");
  const ledger = result.execution_ledger_summary;
  if (!ledger || !ledger.phases || ledger.phases !== ledger.closed_phases) reasons.push("phase_ledger_not_closed");
  if (!validateArtifactManifest(result.artifact_manifest, result.artifact_manifest_hash)) reasons.push("artifact_manifest_invalid");
  const requests = new Map(), repairs = new Map();
  for (const step of result.model_steps || []) {
    for (const request of step.execution_ledger?.requests || []) {
      if (request.stage === "concentrated_repair") requests.set(request.request_id, { ...request, phase_id: step.execution_ledger.phase_id });
    }
    for (const event of step.execution_ledger?.events || []) {
      if (event.status === "repair_result") repairs.set(event.event_id, event);
    }
    if (step.phase_unit_plan?.unit_orders?.some((order) => order.repair_attempts > 1)) reasons.push("unit_repair_limit_exceeded");
  }
  const countKeys = (values, keyOf) => {
    const counts = new Map();
    for (const value of values) { const key = keyOf(value); counts.set(key, (counts.get(key) || 0) + 1); }
    return Math.max(0, ...counts.values());
  };
  const maxUnitRepairs = countKeys(repairs.values(), (event) => `${event.phase_id}:${event.unit}`);
  const maxPhaseRepairs = countKeys(requests.values(), (request) => request.phase_id);
  if (maxUnitRepairs > 1) reasons.push("unit_repair_limit_exceeded");
  if (maxPhaseRepairs > 1) reasons.push("phase_repair_limit_exceeded");
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)],
    max_repairs_per_unit_phase: maxUnitRepairs, max_repair_requests_per_phase: maxPhaseRepairs };
}

function buildAcceptanceJobs({ outputDir, model = "mock_primary", checker = "mock_secondary" }) {
  return ["july", "september", "october"].flatMap((scenario) => ["axis", "allies"].map((side) => ({
    scenario, side,
    ...buildExperimentJobs({ scenario, "external-side": side, "decision-policy": "hierarchical_sae",
      "model-profile": model, "task-checker-model-profile": checker, "tool-profile": "rolling_unit_rules_tactical",
      "step-timeout-ms": "180000", seed: "1942", replicates: "1", "task-management": "multi_task", "out-dir": outputDir })[0]
  })));
}

function spawnLongRunning(command, args, options) {
  // Keep macOS from suspending a long paid batch. The wrapper is scoped to
  // this child and disappears when it exits; other platforms run directly.
  // A detached process group prevents a terminal/session hangup from killing
  // a running game after the launcher has been started in the background.
  const childOptions = { detached: true, ...options };
  return process.platform === "darwin"
    ? spawn("caffeinate", ["-i", command, ...args], childOptions)
    : spawn(command, args, childOptions);
}

function terminateChild(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  terminateProcessGroup(child.pid, signal);
}

function resolveConcurrency({ model, requested, jobCount }) {
  const parsed = requested == null || requested === "" ? null : Number(requested);
  if (parsed != null && (!Number.isInteger(parsed) || parsed < 1)) {
    throw new Error("--concurrency must be a positive integer");
  }
  // Parallelism is safe for offline Mock games. Keep paid/real runs serial
  // unless the operator explicitly opts into concurrency.
  return Math.min(jobCount, parsed || (String(model).startsWith("mock_") ? jobCount : 1));
}

async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--out-dir", "--model-profile", "--task-checker-model-profile", "--concurrency"].includes(argv[i]) || !argv[i + 1]) throw new Error(`invalid argument ${argv[i]}`);
    args[argv[i]] = argv[i + 1];
  }
  if (!args["--out-dir"]) throw new Error("--out-dir is required; every batch uses a new directory");
  const outputDir = path.resolve(args["--out-dir"]);
  const model = args["--model-profile"] || "mock_primary";
  const checker = args["--task-checker-model-profile"] || "mock_secondary";
  const jobs = buildAcceptanceJobs({ outputDir, model, checker });
  const concurrency = resolveConcurrency({ model, requested: args["--concurrency"], jobCount: jobs.length });
  const manifestPath = path.join(outputDir, "batch_manifest.json");
  if (fs.existsSync(manifestPath)) {
    const stale = markStaleManifest(outputDir);
    throw new Error(stale
      ? "existing batch was marked interrupted; use a new directory or resume it explicitly"
      : "batch already exists; no automatic reruns allowed");
  }
  if (jobs.some((job) => fs.existsSync(job.output))) throw new Error("batch output already exists; use a new directory");
  for (const profile of [model, checker]) await closeModelRuntime(createModelRuntime(profile));
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = { protocol: "sae-six-case-acceptance-v1", pid: process.pid, status: "running", started_at: new Date().toISOString(),
    concurrency, model_profile: model, checker_profile: checker, ordinary_api_failover: false, paid_reruns: false,
    diagnostic_only: true, cases: jobs.map((job) => ({ ...job, status: "pending" })) };
  const save = () => {
    fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  };
  save();
  let interrupted = false;
  let terminalFailure = false;
  let activeChildren = new Map();
  const handleSignal = (signal) => {
    if (interrupted) return;
    interrupted = true;
    manifest.status = "interrupted";
    manifest.interrupted_at = new Date().toISOString();
    manifest.interruption_reason = `runner received ${signal}`;
    for (const [entry, child] of activeChildren.entries()) {
      entry.status = "interrupted";
      entry.interrupted_at = manifest.interrupted_at;
      entry.error ||= `runner received ${signal}`;
      entry.signal = signal;
      terminateChild(child, signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    }
    save();
  };
  const handleHangup = () => {
    manifest.last_signal = "SIGHUP";
    manifest.last_signal_at = new Date().toISOString();
    manifest.session_hangup_ignored = true;
    save();
  };
  const failBatch = (kind, error) => {
    terminalFailure = true;
    interrupted = true;
    manifest.status = "failed";
    manifest.finished_at = new Date().toISOString();
    manifest.failure = { kind, message: error?.message || String(error) };
    for (const [entry, child] of activeChildren.entries()) {
      entry.status = "failed";
      entry.error ||= manifest.failure.message;
      terminateChild(child);
    }
    save();
    process.exitCode = 1;
  };
  const handleFatal = (kind, error) => failBatch(kind, error);
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGHUP", handleHangup);
  process.once("uncaughtException", (error) => handleFatal("uncaught_exception", error));
  process.once("unhandledRejection", (error) => handleFatal("unhandled_rejection", error));
  process.once("exit", (code) => {
    if (manifest.status === "running") {
      manifest.status = code === 0 ? "interrupted" : "failed";
      manifest.finished_at = new Date().toISOString();
      manifest.interruption_reason ||= "launcher exited before batch finalization";
      save();
    }
  });

  async function runCase(entry) {
    if (interrupted) return;
    entry.status = "running";
    entry.started_at = new Date().toISOString();
    entry.console_log = entry.output.replace(/\.json$/, ".console.log");
    const fd = fs.openSync(entry.console_log, "a");
    const child = spawnLongRunning(process.execPath, entry.args, { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", fd, fd] });
    entry.pid = child.pid;
    activeChildren.set(entry, child);
    save();
    const outcome = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: 1, error: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    fs.closeSync(fd);
    activeChildren.delete(entry);
    entry.finished_at = new Date().toISOString();
    entry.exit_code = outcome.code;
    entry.signal = outcome.signal || null;
    entry.error = outcome.error || null;
    entry.status = interrupted ? "interrupted" : outcome.code === 0 ? "completed" : "failed";
    try {
    if (interrupted) {
      // Preserve the lifecycle outcome. A partial transcript may exist, but it
      // must not be relabeled as an acceptance failure after an interruption.
    }
    else if (fs.existsSync(entry.output)) {
      const result = await readJsonFile(entry.output);
      entry.game_status = result.status;
      entry.final = result.summary?.victory?.final === true;
      entry.vp = result.summary?.victory?.victory_points;
      entry.illegal_actions = result.counts?.illegal_actions;
      entry.execution_ledger = result.execution_ledger_summary ? {
        phases: result.execution_ledger_summary.phases, closed_phases: result.execution_ledger_summary.closed_phases,
        repairs: result.execution_ledger_summary.batch_repair_requests,
        model_rule_rejections: result.execution_ledger_summary.model_rule_rejections
      } : null;
      entry.context_errors = result.context_store_errors?.length || 0;
      entry.validation = validateAcceptanceResult(result);
      if (!entry.validation.passed) entry.status = "acceptance_failed";
    }
    else entry.status = "failed";
    }
    catch (error) { entry.status = "report_read_failed"; entry.error = error.message; }
    save();
  }

  let nextCase = 0;
  async function worker() {
    while (true) {
      const index = nextCase++;
      if (index >= manifest.cases.length) return;
      try {
        await runCase(manifest.cases[index]);
      }
      catch (error) {
        failBatch("case_runner_error", error);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // All game children have exited before the report process is started.
  // This prevents the report from observing partially written transcripts.
  const files = manifest.cases.filter((entry) => fs.existsSync(entry.output) && entry.status !== "report_read_failed").map((entry) => entry.output);
  const reportPath = path.join(outputDir, "all_scenarios_metrics.json");
  if (!interrupted && files.length) {
    const fd = fs.openSync(path.join(outputDir, "metrics.console.log"), "a");
    const report = spawnLongRunning(process.execPath, ["ai/experiments/evaluate_research_metrics.js", ...files, "--out", reportPath],
      { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", fd, fd] });
    const reportEntry = { pid: report.pid, status: "running", error: null };
    activeChildren.set(reportEntry, report);
    manifest.report_pid = report.pid;
    save();
    const reportOutcome = await new Promise((resolve) => {
      report.once("error", (error) => resolve({ code: 1, error: error.message }));
      report.once("exit", (code, signal) => resolve({ code, signal }));
    });
    activeChildren.delete(reportEntry);
    manifest.report_exit_code = reportOutcome.code;
    manifest.report_signal = reportOutcome.signal || null;
    manifest.report_error = reportOutcome.error || null;
    fs.closeSync(fd);
    manifest.report = reportPath;
  }
  manifest.status = !interrupted && manifest.cases.every((entry) => entry.status === "completed") && manifest.report_exit_code === 0
    ? "completed" : "completed_with_errors";
  if (terminalFailure) manifest.status = "failed";
  else if (interrupted) manifest.status = "interrupted";
  manifest.finished_at = new Date().toISOString();
  save();
  process.removeListener("SIGHUP", handleHangup);
  console.log(JSON.stringify({ manifest: manifestPath, status: manifest.status }));
  if (manifest.status !== "completed") process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildAcceptanceJobs, markStaleManifest, processAlive, resolveConcurrency, terminateProcessGroup, validateAcceptanceResult };
