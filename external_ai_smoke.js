#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = __dirname;
const OUT = path.join(ROOT, "last_external_ai_smoke_report.json");
const NODE = process.execPath;

function moveIntentProbe() {
  const { buildContext, evaluateProbeAction, readConfig } = require("./external_ai_transcript.js");
  const started = Date.now();
  try {
    const config = readConfig();
    const built = buildContext(config, { scenario: "scenarios/july.json" });
    const moveCandidate = (built.publicContext.candidate_actions || []).find((item) => item.action?.type === "move");
    if (!moveCandidate) {
      return {
        label: "move_intent probe",
        command: "internal move_intent probe",
        ok: false,
        status: 1,
        signal: null,
        elapsed_ms: Date.now() - started,
        stdout_tail: "",
        stderr_tail: "no move candidate available"
      };
    }
    const action = {
      type: "move_intent",
      unit: moveCandidate.action.unit,
      destination: moveCandidate.action.destination || moveCandidate.action.path?.at(-1),
      mode: "auto"
    };
    const assessment = evaluateProbeAction(built.publicContext, action, built.ctx);
    const plannedPath = assessment.action?.path || [];
    const ok = !!assessment.legal && assessment.action?.type === "move" && plannedPath.length > 1;
    return {
      label: "move_intent probe",
      command: "internal move_intent probe",
      ok,
      status: ok ? 0 : 1,
      signal: null,
      elapsed_ms: Date.now() - started,
      stdout_tail: JSON.stringify({
        intent: action,
        legal: assessment.legal,
        planned_action: assessment.action,
        planned_from_intent: assessment.planned_from_intent
      }, null, 2),
      stderr_tail: ok ? "" : assessment.reason || "move_intent did not resolve to a legal planned move"
    };
  }
  catch (error) {
    return {
      label: "move_intent probe",
      command: "internal move_intent probe",
      ok: false,
      status: 1,
      signal: null,
      elapsed_ms: Date.now() - started,
      stdout_tail: "",
      stderr_tail: error.message
    };
  }
}

function runStep(label, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(NODE, args, {
    cwd: ROOT,
    encoding: "utf8",
    input: options.input || "",
    timeout: options.timeoutMs || 120000
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  return {
    label,
    command: [NODE, ...args].map((item) => path.basename(item) === path.basename(NODE) ? "node" : item).join(" "),
    ok: options.expectFailure ? result.status !== 0 : result.status === 0,
    expected_failure: !!options.expectFailure,
    status: result.status,
    signal: result.signal || null,
    elapsed_ms: Date.now() - started,
    stdout_tail: stdout.split("\n").slice(-20).join("\n"),
    stderr_tail: stderr.split("\n").slice(-20).join("\n")
  };
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function main() {
  const steps = [];
  const run = (label, args, options) => {
    const step = runStep(label, args, options);
    steps.push(step);
    return step;
  };

  run("syntax external_ai_transcript", ["-c", "external_ai_transcript.js"]);
  run("syntax external_ai_eval", ["-c", "external_ai_eval.js"]);
  run("syntax external_ai_context_audit", ["-c", "external_ai_context_audit.js"]);
  run("syntax external_ai_quality", ["-c", "external_ai_quality.js"]);
  run("syntax external_ai_rollout", ["-c", "external_ai_rollout.js"]);
  run("syntax external_ai_real_check", ["-c", "external_ai_real_check.js"]);
  run("syntax external_ai_probe", ["-c", "external_ai_probe.js"]);
  run("context only", ["external_ai_transcript.js", "--context-only"]);
  run("fast context audit", ["external_ai_context_audit.js"]);
  steps.push(moveIntentProbe());
  run("fast quality gate", ["external_ai_quality.js"]);
  run("rollout gate", ["external_ai_rollout.js"], { timeoutMs: 120000 });
  run("mock review transcript", ["external_ai_transcript.js", "--mock-review"]);
  run("mock eval", [
    "external_ai_eval.js",
    "--transcript", "last_external_ai_mock_transcript.json",
    "--out", "last_external_ai_mock_eval.json"
  ]);
  run("require api rejects mock", [
    "external_ai_eval.js",
    "--transcript", "last_external_ai_mock_transcript.json",
    "--out", "last_external_ai_require_api_eval.json",
    "--require-api"
  ], { expectFailure: true });
  run("rule engine tests", ["rule_engine.test.js"]);

  const artifacts = {};
  for (const [key, file] of Object.entries({
    context: "last_external_ai_context.json",
    audit: "last_external_ai_context_audit.json",
    mock_transcript: "last_external_ai_mock_transcript.json",
    mock_eval: "last_external_ai_mock_eval.json",
    quality: "last_external_ai_quality_report.json",
    rollout: "last_external_ai_rollout_report.json",
    require_api_eval: "last_external_ai_require_api_eval.json"
  })) {
    try { artifacts[key] = readJson(file); }
    catch (error) { artifacts[key] = { error: error.message }; }
  }

  const failures = steps.filter((step) => !step.ok).map((step) => `${step.label}: status ${step.status}${step.signal ? ` signal ${step.signal}` : ""}`);
  if (artifacts.audit.status !== "pass") failures.push(`context audit status ${artifacts.audit.status}`);
  if (artifacts.quality.status !== "pass") failures.push(`quality gate status ${artifacts.quality.status}`);
  if (artifacts.rollout.status !== "pass") failures.push(`rollout gate status ${artifacts.rollout.status}`);
  if (artifacts.mock_eval.status !== "pass") failures.push(`mock eval status ${artifacts.mock_eval.status}`);
  if (artifacts.mock_eval.transcript?.real_model !== false) failures.push("mock eval should not be marked real_model");
  if (artifacts.require_api_eval.status !== "fail") failures.push("require-api eval should fail for mock transcript");
  if (!String(artifacts.require_api_eval.hard_failures || []).includes("transcript is not from a real API model")) {
    failures.push("require-api eval did not report non-real transcript");
  }
  if (!artifacts.mock_eval.transcript?.final_action_review?.used) failures.push("mock transcript did not exercise final_action_review");
  if (artifacts.mock_eval.transcript?.final_action_review?.final_accept !== true) failures.push("mock final action review did not end accepted");
  if (artifacts.mock_eval.transcript?.candidate_match?.candidate_rank !== 1) failures.push("mock final action did not land on rank 1 candidate");
  if (artifacts.mock_eval.context?.coverage?.has_victory_impact !== true) failures.push("mock eval context missing victory_impact coverage");

  const report = {
    generated_at: new Date().toISOString(),
    status: failures.length ? "fail" : "pass",
    failures,
    steps,
    summary: {
      audit_status: artifacts.audit.status || null,
      mock_eval_status: artifacts.mock_eval.status || null,
      quality_status: artifacts.quality.status || null,
      rollout_status: artifacts.rollout.status || null,
      mock_review: artifacts.mock_eval.transcript?.final_action_review || null,
      require_api_status: artifacts.require_api_eval.status || null,
      context_tool_count: (() => {
        try {
          const payload = JSON.parse(artifacts.context.request_body.messages[1].content);
          return payload.context.tools.length;
        }
        catch {
          return null;
        }
      })(),
      victory_impact_cases: Array.isArray(artifacts.audit.cases)
        ? artifacts.audit.cases.map((item) => ({
          label: item.label,
          candidates: item.candidate_count,
          with_victory_impact: item.candidates_with_victory_impact
        }))
        : [],
      quality_cases: Array.isArray(artifacts.quality.cases)
        ? artifacts.quality.cases.map((item) => ({
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
        : []
    }
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: OUT,
    status: report.status,
    failures: report.failures,
    summary: report.summary
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();
