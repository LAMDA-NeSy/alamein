"use strict";

const RulesEngine = require("../../rule_engine.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value, fallback = "", limit = 240) {
  return String(value || fallback || "").trim().slice(0, limit);
}

function id(value, fallback = "goal") {
  return text(value, fallback, 72).replace(/[^a-zA-Z0-9_-]+/g, "_") || fallback;
}

function integer(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function normalizeCondition(item, kind = "soft") {
  if (typeof item === "string") return { kind, description: text(item) };
  if (!item || typeof item !== "object") return null;
  return {
    kind: text(item.kind || item.type, kind, 64),
    description: text(item.description || item.condition || item.value, "observable condition"),
    target: item.target == null ? null : clone(item.target)
  };
}

function normalizeGoal(raw, fallback, priority) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    id: id(value.id, fallback),
    title: text(value.title || value.goal, fallback.replace(/_/g, " "), 160),
    goal_type: text(value.goal_type || value.type, "model_defined", 80),
    priority: Math.max(1, integer(value.priority, priority)),
    rationale: text(value.rationale || value.reason, "", 420),
    target_vp: integer(value.target_vp),
    target_column: integer(value.target_column),
    target_hex: text(value.target_hex, "", 8),
    target_units: Array.isArray(value.target_units) ? value.target_units.map(String).slice(0, 12) : [],
    expected_vp_delta: Number.isFinite(Number(value.expected_vp_delta)) ? Number(value.expected_vp_delta) : null,
    subject_side: ["axis", "allies"].includes(value.subject_side) ? value.subject_side : null,
    metric: text(value.metric, "", 64),
    relation: text(value.relation, "", 32),
    target: value.target == null ? null : clone(value.target),
    evaluation_scope: ["immediate", "turn_end", "game_end"].includes(value.evaluation_scope) ? value.evaluation_scope : null,
    observable_conditions: (Array.isArray(value.observable_conditions) ? value.observable_conditions : [])
      .map((item) => normalizeCondition(item, "soft"))
      .filter(Boolean)
      .slice(0, 8),
    failure_conditions: (Array.isArray(value.failure_conditions) ? value.failure_conditions : [])
      .map((item) => normalizeCondition(item, "soft"))
      .filter(Boolean)
      .slice(0, 6),
    switch_conditions: (Array.isArray(value.switch_conditions) ? value.switch_conditions : [])
      .map((item) => normalizeCondition(item, "soft"))
      .filter(Boolean)
      .slice(0, 6)
  };
}

function normalizePolicy(raw = {}) {
  const minimumOdds = text(raw.minimum_attack_odds, "2-1", 12);
  return {
    main_axis: ["north", "central", "south", "flexible"].includes(raw.main_axis) ? raw.main_axis : "flexible",
    minimum_attack_odds: /^\d+\s*[-:]\s*\d+$/.test(minimumOdds) ? minimumOdds.replace(":", "-") : "2-1",
    supply_policy: text(raw.supply_policy, "Do not sacrifice scoring-eligible supply without an explicit emergency justification.", 240),
    reserve_policy: text(raw.reserve_policy, "Keep a usable reserve unless committing it creates verified progress.", 240),
    risk_posture: ["conservative", "balanced", "aggressive"].includes(raw.risk_posture) ? raw.risk_posture : "balanced",
    allow_low_odds_when: Array.isArray(raw.allow_low_odds_when) ? raw.allow_low_odds_when.map((item) => text(item, "", 120)).filter(Boolean).slice(0, 5) : [],
    policy_version: Math.max(1, integer(raw.policy_version, 1))
  };
}

function hardFacts(publicContext = {}) {
  const scoring = publicContext.victory?.current_scoring || {};
  const advance = scoring.july_advance || {};
  return {
    scenario: publicContext.game?.scenario || "",
    side: publicContext.game?.active_side || "",
    turn: Number(publicContext.game?.turn || 1),
    turns_remaining: Number(publicContext.game?.turns_remaining || 0),
    current_vp: Number(scoring.total_vp ?? publicContext.victory?.current_vp ?? 0),
    current_level: scoring.current_level || publicContext.victory?.current_level || "",
    next_threshold: clone(scoring.next_axis_threshold || {}),
    current_scoring_column: Number.isInteger(Number(advance.farthest_scoring_column)) ? Number(advance.farthest_scoring_column) : null,
    next_scoring_column: Number.isInteger(Number(advance.next_scoring_column)) ? Number(advance.next_scoring_column) : null,
    next_column_vp_gain: Number(advance.vp_gain_for_reaching_next_column || 0),
    scoring_requirement: advance.scoring_requirement || "",
    confirmed_frontier_routes: (publicContext.objective_resolution?.candidates || [])
      .filter((item) => item.crosses_frontier && ["supplied", "partially_supplied"].includes(item.projected_supply))
      .slice(0, 8)
  };
}

function validHex(value, ctx = null) {
  if (!value) return "";
  try {
    const normalized = RulesEngine.normalizeHex(value);
    const [column, row] = RulesEngine.splitHex(normalized);
    const map = ctx?.terrain?.map || {};
    if (map.min_col != null && (column < Number(map.min_col) || column > Number(map.max_col))) return "";
    if (map.min_row != null && (row < Number(map.min_row) || row > Number(map.max_row))) return "";
    return normalized;
  }
  catch { return ""; }
}

function groundGoalPlan(raw, { publicContext = {}, state = {}, side = "", ctx = null } = {}) {
  const source = raw?.goal_plan || raw?.strategic_goal_plan || raw || {};
  const facts = hardFacts(publicContext);
  const campaignRaw = source.campaign_goal || {};
  const primaryRaw = source.primary_goal || source.goal || source.strategic_intent || source;
  const campaign = normalizeGoal(campaignRaw, "campaign_goal", 1);
  const primary = normalizeGoal(primaryRaw, "primary_goal", 1);
  const supporting = (Array.isArray(source.supporting_goals) ? source.supporting_goals : [])
    .map((goal, index) => normalizeGoal(goal, `supporting_goal_${index + 1}`, index + 2))
    .slice(0, 2);
  const corrections = [];
  const validUnits = new Set(Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map(([unitId]) => unitId));

  for (const goal of [campaign, primary, ...supporting]) {
    if (!goal.subject_side) goal.subject_side = side;
    if (!goal.evaluation_scope) goal.evaluation_scope = goal === campaign ? "game_end" : "turn_end";
    if (!goal.metric) goal.metric = goal.target_vp != null ? "axis_vp" : goal.target_column != null ? "scoring_frontier" : "scenario_scoring";
    if (goal.metric === "axis_vp" && goal.target_vp == null && Number.isInteger(Number(goal.target))) {
      goal.target_vp = Number(goal.target);
    }
    if (goal.metric === "scoring_frontier" && goal.target_column == null && Number.isInteger(Number(goal.target))) {
      goal.target_column = Number(goal.target);
    }
    if (!goal.relation) goal.relation = goal.metric === "axis_vp"
      ? (side === "axis" ? "at_least" : "at_most")
      : (side === "axis" ? "at_least" : "keep_below");
    if (goal.target == null) goal.target = goal.metric === "scoring_frontier" ? goal.target_column : goal.target_vp;
    if (facts.scenario === "july" && side === "allies" && goal.target_column != null && goal.metric === "scoring_frontier") {
      if (goal.subject_side !== "axis" || goal.relation !== "keep_below") {
        corrections.push({ field: `${goal.id}.objective_direction`, requested: { subject_side: goal.subject_side, relation: goal.relation }, grounded: { subject_side: "axis", relation: "keep_below" }, reason: "July Allied denial observes the Axis scoring frontier" });
      }
      goal.subject_side = "axis";
      goal.relation = "keep_below";
      goal.evaluation_scope = "game_end";
      goal.metric = "scoring_frontier";
      goal.target = goal.target_column;
    }
    const requestedUnits = [...goal.target_units];
    goal.target_units = goal.target_units.filter((unitId) => validUnits.has(unitId));
    if (goal.target_units.length !== requestedUnits.length) {
      corrections.push({ field: `${goal.id}.target_units`, requested: requestedUnits, grounded: goal.target_units, reason: "unknown, enemy, eliminated, or off-map units removed" });
    }
    if (goal.target_hex) {
      const normalized = validHex(goal.target_hex, ctx);
      if (!normalized) corrections.push({ field: `${goal.id}.target_hex`, requested: goal.target_hex, grounded: "", reason: "invalid hex removed" });
      goal.target_hex = normalized;
    }
    if (facts.scenario === "july" && goal.metric === "scoring_frontier" && goal.target_column != null) {
      const requestedDelta = goal.expected_vp_delta;
      const groundedDelta = goal.subject_side === "axis" && goal.relation === "at_least"
        ? Math.max(0, goal.target_column - Number(facts.current_scoring_column || 34)) * 3
        : 0;
      goal.expected_vp_delta = groundedDelta;
      const defensive = ["keep_below", "at_most"].includes(goal.relation);
      goal.observable_conditions.unshift({
        kind: defensive ? "scoring_frontier_below" : "scoring_frontier_at_least",
        description: defensive
          ? `The observed ${goal.subject_side} scoring frontier remains below column ${goal.target_column}`
          : `A surviving ${goal.subject_side} ground combat unit in column ${goal.target_column} or farther east remains supplied or partially supplied`,
        target: goal.target_column,
        subject_side: goal.subject_side,
        relation: goal.relation
      });
      if (requestedDelta != null && requestedDelta !== groundedDelta) {
        corrections.push({ field: `${goal.id}.expected_vp_delta`, requested: requestedDelta, grounded: groundedDelta, reason: "recomputed from authoritative July scoring rule" });
      }
    }
    if (goal.target_vp != null) {
      const atLeast = !["at_most", "keep_below"].includes(goal.relation);
      goal.observable_conditions.unshift({
        kind: atLeast ? "vp_at_least" : "vp_at_most",
        description: `Axis VP is ${atLeast ? "at least" : "at most"} ${goal.target_vp}`,
        target: goal.target_vp,
        subject_side: "axis",
        relation: atLeast ? "at_least" : "at_most"
      });
    }
    goal.observable_conditions = goal.observable_conditions
      .filter((condition, index, values) => values.findIndex((other) => `${other.kind}:${JSON.stringify(other.target)}` === `${condition.kind}:${JSON.stringify(condition.target)}`) === index)
      .slice(0, 8);
  }

  if (!campaign.title || campaign.title === "campaign goal") {
    campaign.title = facts.next_threshold?.level ? `Reach ${facts.next_threshold.level}` : "Improve the scenario result";
  }
  if (campaign.target_vp == null && Number.isFinite(Number(facts.next_threshold?.vp))) campaign.target_vp = Number(facts.next_threshold.vp);
  if (!primary.rationale) primary.rationale = text(source.rationale, "Choose and execute the most valuable feasible operation from the current position.", 420);
  const operation = id(source.operation || primary.id, "open_operation");
  const plan = {
    type: "grounded_goal_plan",
    protocol: "side-aware-goal-v2",
    side,
    operation,
    campaign_goal: campaign,
    primary_goal: primary,
    supporting_goals: supporting,
    operation_policy: normalizePolicy(source.operation_policy || source.policy),
    strategy_mode: side === "allies"
      ? campaign.target_vp != null && facts.current_vp > campaign.target_vp
        ? "recover_result"
        : primary.target_column != null && facts.current_scoring_column >= primary.target_column - 1
          ? "deny_imminent_scoring"
          : "hold_result"
      : "improve_axis_result",
    hard_facts: facts,
    grounding: {
      valid: true,
      corrections,
      correction_count: corrections.length,
      route_feasibility: facts.confirmed_frontier_routes.length ? "locally_confirmed_option_exists" : "not_locally_confirmed",
      source: "rule_grounded"
    },
    task_plan: source.task_plan || null,
    source: raw?.error ? "local_default" : "model"
  };
  return plan;
}

function localGoalPlan({ publicContext = {}, state = {}, side = "" } = {}) {
  const facts = hardFacts(publicContext);
  const defensive = side === "allies";
  const targetColumn = facts.scenario === "july"
    ? defensive
      ? facts.next_scoring_column
      : Math.max(Number(facts.next_scoring_column || 35), 37)
    : null;
  const plan = groundGoalPlan({
    type: "open_goal_plan",
    operation: "local_scoring_recovery",
    campaign_goal: {
      title: defensive ? "Minimize final Axis VP" : (facts.next_threshold?.level ? `Reach ${facts.next_threshold.level}` : "Improve the scenario result"),
      target_vp: defensive ? 29 : (facts.next_threshold?.vp || null),
      subject_side: "axis",
      metric: "axis_vp",
      relation: defensive ? "at_most" : "at_least",
      evaluation_scope: "game_end"
    },
    primary_goal: targetColumn ? {
      id: defensive ? `deny_column_${targetColumn}` : `secure_column_${targetColumn}`,
      title: defensive ? `Prevent Axis from entering column ${targetColumn}` : `Establish a scoring-eligible unit in column ${targetColumn}`,
      goal_type: defensive ? "deny_scoring_frontier" : "secure_scoring_frontier",
      subject_side: "axis",
      metric: "scoring_frontier",
      relation: defensive ? "keep_below" : "at_least",
      target: targetColumn,
      evaluation_scope: defensive ? "game_end" : "turn_end",
      target_column: targetColumn,
      expected_vp_delta: defensive ? 0 : facts.next_column_vp_gain,
      rationale: defensive ? "Keep the Axis scoring frontier below the defended column." : "Use the authoritative next scoring frontier while preserving supply."
    } : {
      id: "improve_scenario_position",
      title: "Improve the current scenario score",
      goal_type: "scenario_scoring",
      rationale: "Use the authoritative scoring rules and current force state."
    },
    supporting_goals: [{
      id: "preserve_supply",
      title: defensive ? "Preserve the Allied defensive supply network" : "Preserve the operational supply network",
      goal_type: "supply",
      subject_side: side,
      metric: "supply_coverage",
      relation: "preserve"
    }],
    operation_policy: { main_axis: "flexible", minimum_attack_odds: "2-1", risk_posture: "balanced" }
  }, { publicContext, state, side });
  plan.source = "local_default";
  return plan;
}

function goalIntent(goalPlan) {
  const primary = goalPlan.primary_goal || {};
  const axis = goalPlan.operation_policy?.main_axis || "flexible";
  const type = goalPlan.side === "allies" && goalPlan.strategy_mode === "recover_result" ? "pressure"
    : /deny|block|hold|preserv/i.test(primary.goal_type) && goalPlan.side === "allies" ? "consolidate"
    : /supply/i.test(primary.goal_type) ? "supply"
    : /attack|isolate|combat|break/i.test(primary.goal_type) ? "attack_pressure"
      : /hold|protect|consolidat/i.test(primary.goal_type) ? "consolidate" : "advance";
  return {
    type: "phase_intent",
    intent: {
      type,
      sector: ["north", "central", "south"].includes(axis) ? axis : "",
      target_hex: primary.target_hex || "",
      priority_units: primary.target_units || []
    },
    operation: goalPlan.operation,
    target_column: primary.target_column,
    subject_side: primary.subject_side || goalPlan.side,
    metric: primary.metric || "scenario_scoring",
    relation: primary.relation || "at_least",
    evaluation_scope: primary.evaluation_scope || "turn_end",
    strategy_mode: goalPlan.strategy_mode || "",
    objective_type: primary.goal_type,
    required_support: goalPlan.supporting_goals.map((goal) => goal.goal_type).slice(0, 4),
    priorities: [primary.title, ...goalPlan.supporting_goals.map((goal) => goal.title)].slice(0, 6),
    abort_condition: primary.failure_conditions.map((condition) => condition.description).join("; ") || "replan when the grounded goal becomes infeasible",
    success_condition: primary.observable_conditions.map((condition) => condition.description).join("; ") || primary.title,
    fallback_condition: primary.switch_conditions.map((condition) => condition.description).join("; ") || "reassess the goal after repeated grounded no-progress events",
    goal_plan: clone(goalPlan),
    source: goalPlan.source
  };
}

module.exports = {
  goalIntent,
  groundGoalPlan,
  hardFacts,
  localGoalPlan,
  normalizePolicy
};
