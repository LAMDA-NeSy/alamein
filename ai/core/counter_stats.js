"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT } = require("./project_paths.js");

const COUNTER_STATS_FILE = path.join(PROJECT_ROOT, "counter_stats.json");
const PLACEHOLDER_STATUSES = new Set(["needs_manual_review", "needs_counter_read"]);

function readCounterStats(file = COUNTER_STATS_FILE) {
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!document || typeof document !== "object" || Array.isArray(document)
    || !document.stats || typeof document.stats !== "object" || Array.isArray(document.stats)) {
    throw new Error("counter_stats.json must contain a stats object");
  }
  return document.stats;
}

function imageName(unit) {
  return String(unit?.image || "").split("/").pop();
}

function isTurnMarker(unit, id = "") {
  return /game-turn|turn marker|turn-record/i.test(`${id} ${unit?.name || ""} ${imageName(unit)}`);
}

function isScenarioCombatUnit(unit, id = "") {
  if (!unit || unit.off_map || isTurnMarker(unit, id)) return false;
  return unit.kind === "ground" || unit.kind === "engineer";
}

function validateScenarioCounterStats(state, options = {}) {
  const stats = options.stats || readCounterStats(options.file);
  const errors = [];
  const units = state?.units && typeof state.units === "object" ? state.units : {};
  for (const [id, unit] of Object.entries(units)) {
    if (isTurnMarker(unit, id)) continue;
    if (!isScenarioCombatUnit(unit, id)) continue;
    const image = imageName(unit);
    const printed = stats[image];
    if (!printed) {
      errors.push(`${id}: no counter stats for ${image || "missing image"}`);
      continue;
    }
    if (PLACEHOLDER_STATUSES.has(unit.stats_status)) {
      errors.push(`${id}: placeholder stats_status=${unit.stats_status}`);
      continue;
    }
    for (const field of ["attack", "defense", "movement"]) {
      if (!Number.isFinite(Number(unit[field]))) errors.push(`${id}: ${field} is not numeric`);
      else if (Number(unit[field]) !== Number(printed[field])) errors.push(`${id}: ${field}=${unit[field]} does not match ${printed[field]}`);
    }
    if (unit.stats_status !== "verified") errors.push(`${id}: stats_status must be verified`);
    if (!!unit.parenthesized_attack !== !!printed.parenthesizedAttack) {
      errors.push(`${id}: parenthesized attack flag does not match ${image}`);
    }
  }
  if (errors.length && options.throwOnError !== false) {
    throw new Error(`scenario counter stats validation failed: ${errors.join("; ")}`);
  }
  return { valid: errors.length === 0, checked_units: Object.keys(units).filter((id) => isScenarioCombatUnit(units[id], id)).length, errors };
}

module.exports = {
  COUNTER_STATS_FILE,
  isScenarioCombatUnit,
  isTurnMarker,
  readCounterStats,
  validateScenarioCounterStats
};
