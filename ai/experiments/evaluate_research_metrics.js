#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { readConfigFile } = require("../core/config_file.js");
const { defaultLogFile, prepareOutputFile } = require("../core/experiment_log.js");
const {
  closeModelRuntime,
  createChatCompletionsClient,
  createModelRuntime,
  publicRuntimeMetadata,
  resolveModel,
  validateCapabilities
} = require("../core/model_runtime.js");
const { CONFIG_DIR } = require("../core/project_paths.js");
const { promptValue } = require("../core/prompt_registry.js");
const { readJsonFile, writeJsonAtomic } = require("../core/json_file.js");
const {
  attachJudgeResults,
  buildActionWindows,
  buildResearchReport,
  deterministicRunMetrics,
  validateJudgeResult
} = require("./research_metrics.js");

const CONFIG_FILE = path.join(CONFIG_DIR, "research_metrics.yaml");

function parseArgs(argv = process.argv.slice(2)) {
  const options = { files: [], baselines: [], judge: false, out: defaultLogFile("research_metrics_report.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--judge") options.judge = true;
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--judge-model-profile") {
      options.judgeModelProfile = argv[++index];
      options.judge = true;
    }
    else if (arg === "--baseline") options.baselines.push(argv[++index]);
    else if (arg === "--recalculate") options.recalculate = true;
    else if (arg === "--config") options.configFile = argv[++index];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (!options.files.length) throw new Error("provide one or more transcript JSON files");
  return options;
}

function parseJudgeContent(result) {
  const choice = result?.response_json?.choices?.[0] || {};
  const content = choice.message?.content
    || (choice.finish_reason === "stop" ? choice.message?.reasoning_content : "")
    || "";
  if (!content) {
    const suffix = choice.finish_reason === "length" ? " after reaching the output limit" : "";
    throw new Error(`judge returned empty content${suffix}`);
  }
  try { return JSON.parse(content); }
  catch (error) { throw new Error(`invalid judge JSON: ${error.message}`); }
}

async function judgeWindow(client, runtime, config, systemPrompt, window) {
  const started = Date.now();
  let result = null;
  const maxAttempts = Math.max(1, Number(config.judge.protocol_retries || 0) + 1);
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await client.complete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({
            evaluation_request: "wargame_research_metrics_v1",
            rubric: {
              opportunity_types: config.judge.opportunity_types,
              missed_opportunity_scale: config.judge.missed_opportunity_scale,
              plan_coherence_scale: config.judge.plan_coherence_scale
            },
            action_window: window
          }) }
        ],
        temperature: Number(config.judge.temperature ?? 0),
        max_tokens: Number(config.judge.max_output_tokens || 4000),
        response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
        timeout_ms: Number(config.judge.timeout_ms || 120000)
      });
      if (!result.ok) throw new Error(`judge API status ${result.status}`);
      const judgment = validateJudgeResult(parseJudgeContent(result), window);
      attempts.push({
        attempt,
        status: result.status,
        elapsed_ms: result.elapsed_ms,
        error_class: result.error_class || "none",
        outcome: "accepted"
      });
      return {
        window_id: window.window_id,
        window,
        judgment,
        api: {
          status: result.status,
          elapsed_ms: Date.now() - started,
          error_class: result.error_class || "none",
          response_id: result.response_json?.id || null,
          attempts
        }
      };
    }
    catch (error) {
      attempts.push({
        attempt,
        status: result?.status ?? 0,
        elapsed_ms: result?.elapsed_ms ?? 0,
        error_class: result?.error_class || "judge_protocol_failure",
        outcome: "rejected",
        error: error.message
      });
      if (attempt < maxAttempts) {
        const delayMs = Math.max(0, Number(config.judge.protocol_retry_delay_ms || 0));
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return {
        window_id: window.window_id,
        window,
        judgment: null,
        api: {
          status: result?.status ?? 0,
          elapsed_ms: Date.now() - started,
          error_class: result?.error_class || "judge_protocol_failure",
          error: error.message,
          attempts
        }
      };
    }
  }
}

async function evaluateTranscripts(transcripts, config, options = {}) {
  const runs = transcripts.map((transcript) => deterministicRunMetrics(transcript, config));
  const baselineRuns = options.baselineTranscripts || [];
  if (!options.judge) {
    return buildResearchReport(runs, {
      judge_enabled: false,
      judge_note: "Run with --judge or --judge-model-profile to calculate Judge metrics.",
      baseline_runs: baselineRuns
    });
  }

  const profileId = options.judgeModelProfile || config.judge.model_profile;
  const profile = resolveModel(profileId);
  validateCapabilities(profile, { structured_output: true, min_context: 32000 });
  const runtime = createModelRuntime(profile, { run_id: `research-metrics-${Date.now()}` });
  const client = createChatCompletionsClient(runtime);
  const systemPrompt = promptValue("evaluation.research_metrics_judge_system");
  try {
    for (let index = 0; index < transcripts.length; index += 1) {
      if (!runs[index].complete_game) continue;
      const windows = buildActionWindows(transcripts[index]);
      const results = [];
      for (const window of windows) {
        process.stderr.write(`[research-metrics] judging ${window.window_id}\n`);
        results.push(await judgeWindow(client, runtime, config, systemPrompt, window));
      }
      attachJudgeResults(runs[index], windows, results);
    }
    return buildResearchReport(runs, {
      judge_enabled: true,
      judge_model_profile: profileId,
      judge_model_runtime: publicRuntimeMetadata(runtime),
      judge_prompt_hash: crypto.createHash("sha256").update(systemPrompt).digest("hex"),
      judge_usage: runtime.usage,
      judge_transport: runtime.transport,
      baseline_runs: baselineRuns
    });
  }
  finally {
    await closeModelRuntime(runtime);
  }
}

async function main() {
  const options = parseArgs();
  if ([...options.files, ...options.baselines].some((file) => path.resolve(file) === path.resolve(options.out))) {
    throw new Error("report output must not overwrite a source transcript");
  }
  const config = readConfigFile(path.resolve(options.configFile || CONFIG_FILE));
  if (Number(config.version || 0) !== 1) throw new Error("research metrics config version must be 1");
  const transcripts = [];
  for (const file of options.files) transcripts.push(await readJsonFile(path.resolve(file)));
  const baselineTranscripts = [];
  for (const file of options.baselines) baselineTranscripts.push(await readJsonFile(path.resolve(file)));
  options.baselineTranscripts = baselineTranscripts;
  const report = await evaluateTranscripts(transcripts, config, options);
  report.source_provenance = options.files.map((file, index) => ({ file: path.resolve(file),
    experiment_id: transcripts[index].experiment_id || null,
    comparison_contract_hash: transcripts[index].comparison_contract_hash || null,
    source_artifact_hash: transcripts[index].artifact_manifest_hash || null }));
  report.recalculated_from_historical_logs = options.recalculate === true;
  report.recalculation_note = "Source transcripts and contracts are unchanged. Missing evidence remains unknown; recomputation does not upgrade the source experiment contract.";
  const output = prepareOutputFile(options.out);
  writeJsonAtomic(output, report);
  process.stdout.write(`${JSON.stringify({ output, runs: report.runs.length, judge_enabled: report.judge_enabled }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIG_FILE,
  evaluateTranscripts,
  judgeWindow,
  parseArgs,
  parseJudgeContent
};
