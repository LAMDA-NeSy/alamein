#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { makeReplay } = require("./ai_replay.js");
const {
  buildContext,
  evaluateProbeAction,
  finalActionReview,
  publicPayload,
  readConfig,
  runTool,
  systemPrompt
} = require("./external_ai_transcript.js");
const { defaultLogFile, prepareOutputFile } = require("../core/experiment_log.js");
const { PROJECT_ROOT } = require("../core/project_paths.js");
const { resolveControllers } = require("../core/controller_config.js");

const ROOT = PROJECT_ROOT;
const OUT = defaultLogFile("last_external_ai_match_report.json");

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function readLocalEnv() {
  try {
    const result = {};
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
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

function readApiKey() {
  const stdin = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8").trim();
  return stdin || process.env.DEEPSEEK_API_KEY || readLocalEnv().DEEPSEEK_API_KEY || "";
}

async function callModel(config, apiKey, messages, label) {
  const api = config.api;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(api.timeoutSeconds || 30) * 1000);
  try {
    const requestBody = {
      model: api.model,
      messages,
      temperature: Number(api.temperature ?? 0.25),
      max_tokens: Math.min(Number(api.maxTokens || 3600), 2400),
      response_format: api.responseFormat || { type: "json_object" }
    };
    const response = await fetch(api.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const responseText = await response.text();
    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    }
    catch {
      responseJson = { raw_text: responseText };
    }
    return { label, ok: response.ok, status: response.status, elapsed_ms: Date.now() - started, response_json: responseJson };
  }
  finally {
    clearTimeout(timer);
  }
}

function messageText(result) {
  return result.response_json?.choices?.[0]?.message?.content || "";
}

function parseJsonFromResult(result) {
  const content = messageText(result);
  if (!content) return null;
  try {
    return JSON.parse(content);
  }
  catch (error) {
    return { parse_error: error.message, content };
  }
}

function compactCandidate(item) {
  if (!item) return null;
  return {
    score: item.score,
    type: item.action?.type || "",
    unit: item.action?.unit || item.action?.attackers?.join(",") || "",
    destination: item.action?.destination || item.action?.path?.at?.(-1) || "",
    summary: item.evaluation?.summary || "",
    risks: item.evaluation?.risks || []
  };
}

function compactToolResult(record) {
  return {
    tool: record.tool,
    arguments: record.arguments,
    legal: record.result?.legal ?? null,
    reason: record.result?.reason || ""
  };
}

function makeExternalProvider(config, apiKey, options = {}) {
  const maxRounds = Number(options.maxToolRounds ?? config.api.maxToolRounds ?? 4);
  return async function externalAction({ state, step }) {
    const started = Date.now();
    const built = buildContext(config, { state });
    const context = built.publicContext;
    const toolEnv = { ctx: built.ctx, allUnits: built.allUnits };
    const toolResults = [];
    const rounds = [];
    let finalReviewUsed = false;
    for (let round = 0; round <= maxRounds; round += 1) {
      const messages = [
        { role: "system", content: systemPrompt(config, "candidates", state.active_side) },
        { role: "user", content: JSON.stringify(publicPayload(config, context, toolResults)) }
      ];
      const result = await callModel(config, apiKey, messages, `step_${step}_round_${round}`);
      const parsed = parseJsonFromResult(result);
      const roundRecord = {
        round,
        ok: result.ok,
        status: result.status,
        elapsed_ms: result.elapsed_ms,
        parsed_output: parsed,
        response_id: result.response_json?.id || null
      };
      rounds.push(roundRecord);
      if (!result.ok) throw new Error(`model API status ${result.status}`);
      if (!parsed || parsed.parse_error) throw new Error(parsed?.parse_error || "model returned empty JSON");
      if (parsed.type === "tool_call") {
        const toolResult = runTool(toolEnv, context, parsed.tool, parsed.arguments || {});
        const record = { tool: parsed.tool, arguments: parsed.arguments || {}, result: toolResult };
        toolResults.push(record);
        roundRecord.tool_result = compactToolResult(record);
        continue;
      }
      const finalAction = parsed.type === "final_action" ? parsed.action : parsed.action || parsed;
      const assessment = evaluateProbeAction(context, finalAction, built.ctx);
      const review = finalActionReview(context, finalAction, assessment);
      roundRecord.assessment = {
        legal: assessment.legal,
        score: assessment.score,
        reason: assessment.reason || "",
        candidate_rank: assessment.candidate_match?.candidate_rank || null,
        exact_candidate: !!assessment.candidate_match?.exact_candidate
      };
      roundRecord.final_action_review = {
        accept: review.accept,
        issues: review.issues || []
      };
      if (!review.accept && !finalReviewUsed && round < maxRounds) {
        finalReviewUsed = true;
        toolResults.push({ tool: "final_action_review", arguments: { action: finalAction }, result: review });
        continue;
      }
      return {
        action: assessment.action || finalAction,
        candidates: (context.candidate_actions || []).slice(0, 5).map(compactCandidate),
        model: {
          provider: config.provider,
          model: config.api.model,
          elapsed_ms: Date.now() - started,
          context_bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
          rounds: rounds.length,
          tool_calls: toolResults.filter((item) => item.tool !== "final_action_review").map(compactToolResult),
          final_accepted: review.accept,
          final_issues: review.issues || [],
          candidate_rank: assessment.candidate_match?.candidate_rank || null,
          exact_candidate: !!assessment.candidate_match?.exact_candidate,
          score: assessment.score ?? null,
          top_candidate: compactCandidate(context.candidate_actions?.[0])
        }
      };
    }
    throw new Error("model did not produce a final action within tool round limit");
  };
}

async function main() {
  const config = readConfig();
  const apiKey = readApiKey();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required via stdin, env, or .env");
  const scenario = argValue("--scenario", "july");
  const controllers = resolveControllers({
    externalSide: argValue("--external-side", "") || undefined,
    axisController: argValue("--axis-controller", "") || undefined,
    alliesController: argValue("--allies-controller", "") || undefined
  });
  const externalSide = controllers.external_side || "axis";
  const outFile = prepareOutputFile(argValue("--out", OUT));
  const maxSteps = Number(argValue("--max-steps", 80));
  const seed = Number(argValue("--seed", 1942));
  const replay = makeReplay(scenario, { seed });
  const started = Date.now();
  const result = await replay.playWithProvider({
    maxSteps,
    controllers,
    externalAction: makeExternalProvider(config, apiKey)
  });
  const summary = replay.summary(result);
  const externalActions = (result.log || []).filter((item) => item.source === "external_model");
  const rulesActions = (result.log || []).filter((item) => item.source === "rules_ai");
  const report = {
    generated_at: new Date().toISOString(),
    status: result.status,
    elapsed_ms: Date.now() - started,
    scenario,
    external_side: externalSide,
    controllers: { axis: controllers.axis, allies: controllers.allies },
    axis_controller: controllers.axis,
    allies_controller: controllers.allies,
    rules_side: controllers.axis === "rules_ai" && controllers.allies === "external_ai" ? "axis" : controllers.allies === "rules_ai" && controllers.axis === "external_ai" ? "allies" : null,
    model: {
      provider: config.provider,
      model: config.api.model,
      url: config.api.url
    },
    summary,
    counts: {
      external_actions: externalActions.length,
      rules_actions: rulesActions.length,
      illegal_actions: (result.log || []).filter((item) => item.result && item.result.legal === false).length,
      model_tool_calls: externalActions.reduce((sum, item) => sum + Number(item.model?.tool_calls?.length || 0), 0)
    },
    log: result.log
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: outFile,
    status: report.status,
    elapsed_ms: report.elapsed_ms,
    scenario,
    external_side: externalSide,
    model: report.model.model,
    victory: summary.victory,
    counts: report.counts,
    tail: summary.tail
  }, null, 2));
  if (report.status === "illegal_action" || report.status === "provider_error") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  });
}
