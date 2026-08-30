#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { defaultLogFile, prepareOutputFile } = require("../core/experiment_log.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");

const ROOT = PROJECT_ROOT;
const SCRIPT_DIR = __dirname;
const NODE = process.execPath;
const TRANSCRIPT_OUT = defaultLogFile("last_external_ai_transcript.json");
const EVAL_OUT = defaultLogFile("last_external_ai_eval.json");
const QUALITY_OUT = defaultLogFile("last_external_ai_real_quality.json");
const REPORT_OUT = defaultLogFile("last_external_ai_real_check.json");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8").trim();
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

function runNode(label, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(NODE, args, {
    cwd: ROOT,
    encoding: "utf8",
    input: options.input || "",
    timeout: options.timeoutMs || 180000
  });
  return {
    label,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    elapsed_ms: Date.now() - started,
    stdout_tail: String(result.stdout || "").trim().split("\n").slice(-20).join("\n"),
    stderr_tail: String(result.stderr || "").trim().split("\n").slice(-20).join("\n")
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function successfulStep(steps, label) {
  return steps.some((step) => step.label === label && step.ok);
}

function main() {
  const localEnv = readLocalEnv();
  const apiKey = readStdin() || process.env.DEEPSEEK_API_KEY || localEnv.DEEPSEEK_API_KEY || "";
  const transcriptOut = prepareOutputFile(argValue("--transcript-out", TRANSCRIPT_OUT));
  const evalOut = prepareOutputFile(argValue("--eval-out", EVAL_OUT));
  const qualityOut = prepareOutputFile(argValue("--quality-out", QUALITY_OUT));
  const reportOut = prepareOutputFile(argValue("--out", REPORT_OUT));
  const scenario = argValue("--scenario", "");
  const phase = argValue("--phase", "");
  const activeSide = argValue("--active-side", "");
  const turn = argValue("--turn", "");
  const transcriptArgs = [path.join(SCRIPT_DIR, "external_ai_transcript.js"), "--out", transcriptOut];
  if (scenario) transcriptArgs.push("--scenario", scenario);
  if (phase) transcriptArgs.push("--phase", phase);
  if (activeSide) transcriptArgs.push("--active-side", activeSide);
  if (turn) transcriptArgs.push("--turn", turn);
  const qualityArgs = [path.join(SCRIPT_DIR, "external_ai_quality.js"), "--out", qualityOut];
  if (scenario) qualityArgs.push("--scenario", scenario);
  if (phase) qualityArgs.push("--phase", phase);
  if (activeSide) qualityArgs.push("--active-side", activeSide);
  if (turn) qualityArgs.push("--turn", turn);

  const steps = [];
  if (!apiKey) {
    const report = {
      generated_at: new Date().toISOString(),
      status: "fail",
      failures: ["API key is required on stdin"],
      steps
    };
    fs.writeFileSync(reportOut, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output: reportOut, status: report.status, failures: report.failures }, null, 2));
    process.exitCode = 1;
    return;
  }

  steps.push(runNode("quality gate", qualityArgs, { timeoutMs: 120000 }));
  if (steps.at(-1).ok) {
    steps.push(runNode("real api transcript", transcriptArgs, { input: `${apiKey}\n`, timeoutMs: 180000 }));
  }
  if (steps.at(-1).ok) {
    steps.push(runNode("require api eval", [
      path.join(SCRIPT_DIR, "external_ai_eval.js"),
      "--transcript", transcriptOut,
      "--out", evalOut,
      "--require-api"
    ]));
  }

  let evalReport = null;
  let qualityReport = null;
  if (successfulStep(steps, "quality gate")) {
    try { qualityReport = readJson(qualityOut); }
    catch {}
  }
  if (successfulStep(steps, "require api eval")) {
    try { evalReport = readJson(evalOut); }
    catch {}
  }
  const failures = steps.filter((step) => !step.ok).map((step) => `${step.label}: status ${step.status}${step.signal ? ` signal ${step.signal}` : ""}`);
  if (qualityReport && qualityReport.status !== "pass") failures.push(`quality gate status ${qualityReport.status}`);
  if (evalReport && evalReport.status !== "pass") failures.push(`require-api eval status ${evalReport.status}`);
  if (evalReport && evalReport.transcript?.real_model !== true) failures.push("transcript is not marked real_model");
  const report = {
    generated_at: new Date().toISOString(),
    status: failures.length ? "fail" : "pass",
    failures,
    files: {
      quality: qualityOut,
      transcript: transcriptOut,
      eval: evalOut,
      output: reportOut
    },
    scenario: scenario || null,
    phase: phase || null,
    active_side: activeSide || null,
    turn: turn || null,
    steps,
    quality_summary: qualityReport ? {
      status: qualityReport.status,
      failures: qualityReport.failures,
      warnings: qualityReport.warnings,
      cases: (qualityReport.cases || []).map((item) => ({
        label: item.label,
        status: item.status,
        elapsed_ms: item.metrics?.elapsed_ms,
        context_bytes: item.metrics?.context_bytes,
        top: item.metrics?.top ? {
          type: item.metrics.top.type,
          score: item.metrics.top.score,
          summary: item.metrics.top.summary
        } : null
      }))
    } : null,
    eval_summary: evalReport ? {
      status: evalReport.status,
      transcript_mode: evalReport.transcript?.mode,
      real_model: evalReport.transcript?.real_model,
      final_action: evalReport.transcript?.final_action,
      candidate_match: evalReport.transcript?.candidate_match,
      final_action_review: evalReport.transcript?.final_action_review,
      hard_failures: evalReport.hard_failures,
      warnings: evalReport.warnings
    } : null
  };
  fs.writeFileSync(reportOut, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: reportOut,
    status: report.status,
    failures: report.failures,
    quality_summary: report.quality_summary,
    eval_summary: report.eval_summary
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();
