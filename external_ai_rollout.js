#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RulesEngine = require("./rule_engine.js");
const { buildContext, readConfig } = require("./external_ai_transcript.js");

const ROOT = __dirname;
const OUT = path.join(ROOT, "last_external_ai_rollout_report.json");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function recoverSpentForSide(state, side) {
  for (const unit of Object.values(state.units || {})) {
    if (unit.side !== side) continue;
    unit.state = "fresh";
    unit.attacked_this_turn = false;
    unit.attacked_this_phase = false;
    unit.defended_this_phase = false;
    unit.mine_cleared_this_turn = false;
    unit.cleared_mine_this_turn = false;
    unit.engineer_assisted_this_turn = false;
    unit.just_cleared_mine_hex = null;
  }
}

function recoverMovementSpentForSide(state, side) {
  for (const unit of Object.values(state.units || {})) {
    if (unit.side === side && !unit.eliminated) unit.state = "fresh";
  }
}

function advancePhase(ctx) {
  const before = { turn: Number(ctx.state.turn || 1), phase: ctx.state.phase, active_side: ctx.state.active_side };
  const next = RulesEngine.nextPhase(ctx);
  if (next.turn_increment) {
    ctx.state.turn = Number(ctx.state.turn || 1) + next.turn_increment;
    recoverSpentForSide(ctx.state, "axis");
    recoverSpentForSide(ctx.state, "allies");
  }
  ctx.state.phase = next.phase;
  ctx.state.active_side = next.active_side;
  if (RulesEngine.phaseKind(ctx.state.phase) === "combat") recoverMovementSpentForSide(ctx.state, ctx.state.active_side);
  return { before, after: { turn: ctx.state.turn, phase: ctx.state.phase, active_side: ctx.state.active_side } };
}

function applyAction(ctx, action) {
  if (!action || action.type === "pass") return { legal: true, applied: false, advanced: advancePhase(ctx), reason: "pass" };
  if (action.type === "move") {
    const verdict = RulesEngine.checkMove(ctx, action.unit, action.path || [], { mode: action.mode || "normal" });
    if (!verdict.legal) return { legal: false, applied: false, reason: verdict.reason, verdict };
    const unit = ctx.state.units[action.unit];
    unit.hex = RulesEngine.normalizeHex((action.path || []).at(-1));
    unit.state = "spent";
    unit.road_mode = action.mode === "road";
    unit.road_facing = (action.path || []).length > 1
      ? RulesEngine.hexDirection((action.path || []).at(-2), (action.path || []).at(-1))
      : unit.road_facing;
    unit.facing = unit.road_facing;
    if (RulesEngine.isEngineer({ id: action.unit, ...unit }) &&
        RulesEngine.phaseKind(ctx.state.phase) === "initial_movement" &&
        RulesEngine.enemyMinesAt(ctx, unit.side, unit.hex).length) {
      RulesEngine.clearMine(ctx, action.unit, unit.hex);
    }
    return { legal: true, applied: true, reason: "move applied", verdict };
  }
  if (action.type === "combat") {
    const verdict = RulesEngine.checkCombat(ctx, action);
    if (!verdict.legal) return { legal: false, applied: false, reason: verdict.reason, verdict };
    const result = RulesEngine.resolveCombat(ctx, { ...action, die: 4 });
    return { legal: !!result.legal, applied: !!result.legal, reason: result.reason, verdict: result };
  }
  if (action.type === "exit_west") {
    const unit = ctx.state.units[action.unit];
    if (!unit) return { legal: false, applied: false, reason: `unknown unit ${action.unit}` };
    const col = Number(RulesEngine.normalizeHex(unit.hex || "").slice(0, 2));
    if (ctx.state.scenario !== "october" || unit.side !== "axis" || col !== 1 || Number(ctx.state.turn || 1) <= 10) {
      return { legal: false, applied: false, reason: "exit_west is not legal in this rollout state" };
    }
    unit.exited_edge = "west";
    unit.exit_edge = "west";
    unit.exited_turn = Number(ctx.state.turn || 1);
    unit.exit_turn = Number(ctx.state.turn || 1);
    unit.off_map = true;
    unit.state = "spent";
    return { legal: true, applied: true, reason: "exit_west applied" };
  }
  return { legal: false, applied: false, reason: `unknown action type ${action.type}` };
}

function runCase(config, item, options = {}) {
  let state = readJson(item.scenario || "scenarios/july.json");
  if (item.phase) state.phase = item.phase;
  if (item.activeSide) state.active_side = item.activeSide;
  if (item.turn != null) state.turn = Number(item.turn);
  const steps = [];
  const maxSteps = Number(options.maxSteps || 10);
  let repeatedPasses = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const started = Date.now();
    const built = buildContext(config, { state });
    const context = built.publicContext;
    const ctx = built.ctx;
    const top = context.candidate_actions[0] || null;
    const action = top?.action || { type: "pass", reason: "No candidate" };
    const before = { turn: ctx.state.turn, phase: ctx.state.phase, active_side: ctx.state.active_side };
    const applied = applyAction(ctx, action);
    if (action.type === "pass") repeatedPasses += 1;
    else repeatedPasses = 0;
    steps.push({
      step: step + 1,
      before,
      elapsed_ms: Date.now() - started,
      context_bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
      candidate_count: context.candidate_actions.length,
      top: top ? { score: top.score, type: top.action?.type, summary: top.evaluation?.summary || "" } : null,
      applied: { legal: applied.legal, applied: applied.applied, reason: applied.reason },
      after: { turn: ctx.state.turn, phase: ctx.state.phase, active_side: ctx.state.active_side }
    });
    if (!applied.legal) break;
    if (action.type !== "pass") advancePhase(ctx);
    state = cloneJson(ctx.state);
  }
  const failures = [];
  const warnings = [];
  if (steps.some((step) => !step.applied.legal)) failures.push("rollout produced illegal top action");
  if (steps.some((step) => step.context_bytes > Number(options.maxContextBytes || 110000))) failures.push("rollout context exceeded byte limit");
  if (steps.some((step) => step.elapsed_ms > Number(options.maxElapsedMs || 15000))) warnings.push("rollout context generation exceeded elapsed threshold");
  if (repeatedPasses >= 3) warnings.push("rollout ended with three or more repeated passes");
  const usefulActions = steps.filter((step) => step.top?.type && step.top.type !== "pass").length;
  if (!usefulActions) warnings.push("rollout had no useful non-pass top action");
  return {
    label: item.label,
    scenario: item.scenario,
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    failures,
    warnings,
    steps,
    useful_top_actions: usefulActions
  };
}

function cases() {
  return [
    { label: "july-axis-open", scenario: "scenarios/july.json" },
    { label: "september-axis-open", scenario: "scenarios/september.json" },
    { label: "october-allies-open", scenario: "scenarios/october.json" }
  ];
}

function main() {
  const config = readConfig();
  const outFile = path.resolve(argValue("--out", OUT));
  const maxSteps = Number(argValue("--steps", 4));
  const results = cases().map((item) => runCase(config, item, { maxSteps }));
  const failures = results.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`));
  const warnings = results.flatMap((item) => item.warnings.map((warning) => `${item.label}: ${warning}`));
  const report = {
    generated_at: new Date().toISOString(),
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    failures,
    warnings,
    cases: results
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: outFile,
    status: report.status,
    failures,
    warnings,
    cases: results.map((item) => ({
      label: item.label,
      status: item.status,
      useful_top_actions: item.useful_top_actions,
      steps: item.steps.length,
      first_top: item.steps[0]?.top || null,
      last_after: item.steps.at(-1)?.after || null
    }))
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { runCase };
