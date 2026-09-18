"use strict";

const RATIO_METRICS = new Set(["unit_survival", "survival", "unit_supply", "supply_coverage", "assigned_supply_ratio", "position", "at_target"]);
const COUNT_METRICS = new Set(["surviving_unit_count", "supplied_unit_count", "units_at_target", "assigned_units_alive", "axis_exited_units", "axis_mines_cleared", "mine_clearance", "withdrawal_units", "zoc_exposed", "combat_opportunity"]);
const METRICS = new Set([...RATIO_METRICS, ...COUNT_METRICS, "target_distance", "scoring_frontier", "target_column", "axis_vp", "axis_exit_vp", "withdrawal_vp", "blocking_line"]);
const SCOPES = new Set(["immediate", "turn_end", "game_end"]);
const RELATIONS = new Set(["at_least", "at_most", "keep_below", "preserve", "reduce", "equal", "equals", "eq", "greater_than", "gt"]);

function regionContains(region, hex) {
  if (!region || !hex) return false;
  if (Array.isArray(region.hexes)) return region.hexes.includes(hex);
  const column = Number(String(hex).slice(0, 2));
  if (Number.isInteger(region.column)) return column === region.column;
  return (region.min_column != null || region.max_column != null)
    && column >= (region.min_column ?? 1) && column <= (region.max_column ?? 99);
}

function predicateErrors(item) {
  const errors = [];
  if (!METRICS.has(item.metric)) errors.push("unknown_metric");
  if (!RELATIONS.has(item.relation)) errors.push("unknown_relation");
  if (!SCOPES.has(item.evaluation_scope)) errors.push("unknown_evaluation_scope");
  if (item.subject_side && !["axis", "allies"].includes(item.subject_side)) errors.push("invalid_subject_side");
  if (typeof item.target !== "number" || !Number.isFinite(item.target)) errors.push("target_must_be_finite_number");
  else {
    if (RATIO_METRICS.has(item.metric) && (item.target < 0 || item.target > 1)) errors.push("ratio_target_outside_0_1");
    if (COUNT_METRICS.has(item.metric) && (!Number.isInteger(item.target) || item.target < 0)) errors.push("count_target_must_be_nonnegative_integer");
    if (item.metric === "target_distance" && item.target < 0) errors.push("distance_must_be_nonnegative");
  }
  if (item.aggregation && !["min", "max"].includes(item.aggregation)) errors.push("unknown_aggregation");
  if (item.target_hex && (typeof item.target_hex !== "string" || !/^\d{4}$/.test(item.target_hex))) errors.push("invalid_target_hex");
  if (item.target_region?.hexes && (!Array.isArray(item.target_region.hexes)
    || item.target_region.hexes.some((hex) => typeof hex !== "string" || !/^\d{4}$/.test(hex)))) errors.push("invalid_target_region");
  if (item.target_region) {
    const region = item.target_region;
    const forms = Number(region.hexes != null) + Number(region.column != null)
      + Number(region.min_column != null || region.max_column != null);
    if (forms !== 1 || Object.keys(region).some((key) => !["hexes", "column", "min_column", "max_column"].includes(key))) errors.push("invalid_target_region");
    for (const key of ["column", "min_column", "max_column"]) {
      if (region[key] != null && (!Number.isInteger(region[key]) || region[key] < 1 || region[key] > 99)) errors.push("invalid_region_column");
    }
    if (region.min_column != null && region.max_column != null && region.min_column > region.max_column) errors.push("reversed_region_bounds");
    if (Array.isArray(region.hexes) && !region.hexes.length) errors.push("empty_target_region");
  }
  return errors;
}

function acceptanceErrors(task, criteria) {
  if (!task.require_acceptance_contract) return [];
  const contract = task.acceptance_contract;
  const errors = [];
  const conditions = [...(criteria.all || []), ...(criteria.any || [])];
  const ids = conditions.map((item) => item.id).filter(Boolean);
  if (ids.length !== conditions.length || new Set(ids).size !== ids.length) errors.push("completion_conditions_need_unique_ids");
  if (!contract || !Array.isArray(contract.obligations) || !contract.obligations.length) return [...errors, "missing_acceptance_obligations"];
  if (!SCOPES.has(contract.evaluation_scope)) errors.push("missing_acceptance_scope");
  if (contract.mode && !["at_settlement", "maintain"].includes(contract.mode)) errors.push("invalid_acceptance_mode");
  const rank = { immediate: 0, turn_end: 1, game_end: 2 };
  const covered = new Set();
  for (const obligation of contract.obligations) {
    const refs = obligation.condition_ids;
    if (!obligation.description || !Array.isArray(refs) || !refs.length) {
      errors.push("obligation_needs_description_and_conditions");
      continue;
    }
    for (const id of refs) {
      covered.add(id);
      const condition = conditions.find((item) => item.id === id);
      if (!condition) errors.push(`unknown_obligation_condition:${id}`);
      else if (rank[condition.evaluation_scope] < rank[contract.evaluation_scope]) errors.push(`condition_settles_before_promise:${id}`);
    }
  }
  if (ids.some((id) => !covered.has(id))) errors.push("completion_condition_without_obligation");
  // Check explicit structured targets only, never infer a mission from prose.
  const occupies = (item) => ["position", "at_target", "units_at_target"].includes(item.metric)
    && ["at_least", "equal", "equals", "eq", "greater_than", "gt"].includes(item.relation) && Number(item.target) > 0;
  const exactLocation = (item) => occupies(item)
    || item.metric === "target_distance" && Number(item.target) === 0 && ["at_most", "equal", "equals", "eq"].includes(item.relation);
  const guaranteed = (predicate) => (criteria.all || []).some(predicate)
    || !!criteria.any?.length && criteria.any.every(predicate);
  if (task.target_role !== "reference" && task.target_hex && !guaranteed((item) =>
    item.target_hex === task.target_hex && (exactLocation(item) || item.metric === "mine_clearance")
    || exactLocation(item) && item.target_region?.hexes?.length === 1 && item.target_region.hexes[0] === task.target_hex)) errors.push("declared_hex_without_location_or_effect_evidence");
  if (task.target_role !== "reference" && task.target_column != null && !guaranteed((item) =>
    exactLocation(item) && item.target_hex && Number(item.target_hex.slice(0, 2)) === Number(task.target_column)
    || occupies(item) && item.target_region?.hexes?.length && item.target_region.hexes.every((hex) => Number(hex.slice(0, 2)) === Number(task.target_column))
    || occupies(item)
      && (Number(item.target_region?.column) === Number(task.target_column) || Number(item.target_region?.min_column) === Number(task.target_column))
    || ["scoring_frontier", "target_column"].includes(item.metric) && Number(item.target) === Number(task.target_column))) errors.push("declared_column_without_location_evidence");
  return [...new Set(errors)];
}

module.exports = { predicateErrors, acceptanceErrors, regionContains };
