"use strict";

const CONTEXT_PROFILE_ID = "compact_current_state_v3";

function boundedList(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function compactMapReference(reference) {
  if (!reference || typeof reference !== "object") return reference;
  return {
    format: reference.format,
    purpose: reference.purpose,
    orientation: reference.orientation,
    coordinate_format: reference.coordinate_format,
    connection_rule: reference.connection_rule,
    layout_rows: reference.layout_rows,
    // The offset rule and row layout are sufficient for the opening projection;
    // exact landmark adjacency is available from view_map and the persisted map file.
    key_connections: [],
    full_local_connections: reference.full_local_connections
  };
}

function pickDefined(value, keys) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function compactGameOverview(overview, includeInitialMap) {
  if (!overview || typeof overview !== "object") return overview;
  return {
    ...pickDefined(overview, [
      "title", "game_type", "current_scenario", "current_side", "objective",
      "turn_goal_update", "player_goal_summary", "player_goal", "victory_decision", "scoring_rules",
      "decision_order", "information_boundaries"
    ]),
    ...(includeInitialMap && overview.initial_map_reference_2d
      ? { initial_map_reference_2d: compactMapReference(overview.initial_map_reference_2d) }
      : {})
  };
}

function compactDynamicGameOverview(overview) {
  return pickDefined(overview, [
    "current_side", "turn_goal_update", "player_goal", "victory_decision"
  ]);
}

function compactGoal(goal) {
  return pickDefined(goal, [
    "id", "title", "goal_type", "priority", "rationale", "target_vp",
    "target_column", "target_hex", "target_units", "expected_vp_delta",
    "subject_side", "metric", "relation", "target", "evaluation_scope",
    "observable_conditions", "failure_conditions", "switch_conditions"
  ]);
}

function compactGoalPlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  return {
    ...pickDefined(plan, ["type", "protocol", "side", "operation", "strategy_mode", "operation_policy", "hard_facts", "grounding", "source"]),
    campaign_goal: compactGoal(plan.campaign_goal),
    primary_goal: compactGoal(plan.primary_goal),
    supporting_goals: boundedList(plan.supporting_goals, 4).map(compactGoal)
  };
}

function compactStrategicIntent(intent, includeGoalPlan = true) {
  if (!intent || typeof intent !== "object") return intent;
  return {
    ...pickDefined(intent, [
      "type", "intent", "operation", "target_column", "objective_type",
      "required_support", "priorities", "abort_condition", "success_condition",
      "fallback_condition", "source"
    ]),
    ...(includeGoalPlan ? { goal_plan: compactGoalPlan(intent.goal_plan) } : {})
  };
}

function compactTask(task) {
  return pickDefined(task, [
    "id", "type", "title", "priority", "depends_on", "target_column",
    "sequence_index", "requires_scoring_supply", "required_for_parent",
    "assigned_units", "compatible_units", "completion_condition", "failure_condition",
    "progress", "status", "next_action", "last_blocked_reason", "source",
    "activation_reason", "tactical_opportunities", "current_metrics", "progress_evidence"
  ]);
}

function compactTaskPlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  return {
    ...pickDefined(plan, ["type", "protocol", "side", "normalized"]),
    parent: pickDefined(plan.parent, [
      "id", "title", "objective", "completion_condition", "failure_condition",
      "target_column", "subject_side", "metric", "relation", "evaluation_scope",
      "state", "started_turn", "started_vp", "partial_success", "goal_progress_evidence"
    ]),
    children: boundedList(plan.children, 6).map(compactTask)
  };
}

function compactFrontierBreakthrough(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...pickDefined(value, [
      "protocol", "current_column", "target_column", "vp_gain_at_target",
      "scoring_requirement", "next_step", "recommended_unit_ids",
      "preparation_actions", "model_freedom"
    ]),
    direct_entry_routes: boundedList(value.direct_entry_routes, 5),
    scoring_eligible_direct_routes: boundedList(value.scoring_eligible_direct_routes, 5),
    approach_routes: boundedList(value.approach_routes, 5)
  };
}

function compactPhaseDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== "object") return dispatch;
  return {
    ...pickDefined(dispatch, [
      "phase_kind", "rule", "primary_task_id", "preferred_units",
      "allowed_unit_ids", "eligible_units_at_phase_start"
    ]),
    tasks: boundedList(dispatch.tasks, 3).map(compactTask),
    frontier_breakthrough: compactFrontierBreakthrough(dispatch.frontier_breakthrough)
  };
}

function compactOperationState(state) {
  if (!state || typeof state !== "object") return state;
  return {
    ...pickDefined(state, [
      "version", "operation", "target_column", "operation_policy", "status", "target",
      "units", "phase", "phase_kind", "current_vp", "next_required_task", "progress",
      "execution_brief", "warnings", "source"
    ]),
    task_plan: compactTaskPlan(state.task_plan),
    active_tasks: boundedList(state.active_tasks, 3).map(compactTask),
    phase_dispatch: compactPhaseDispatch(state.phase_dispatch)
  };
}

function compactPhaseStatus(status) {
  if (!status || typeof status !== "object") return status;
  return {
    ...pickDefined(status, [
      "ok", "read_only", "snapshot", "remaining_units", "unavailable_units",
      "has_legal_non_pass_action", "can_pass", "counts", "advance_reason"
    ]),
    remaining_unit_details: boundedList(status.remaining_unit_details, 24),
    mandatory_actions: boundedList(status.mandatory_actions, 8)
  };
}

function compactMapIntel(mapIntel = {}) {
  return {
    description: mapIntel.description,
    key_hexes: boundedList(mapIntel.key_hexes, 8),
    frontline: boundedList(mapIntel.frontline, 6)
  };
}

function compactTools(tools) {
  return boundedList(tools, 32).map((tool) => ({ name: tool?.name })).filter((tool) => tool.name);
}

function compactAgentPayload(payload, options = {}) {
  const context = payload?.context || {};
  const mapIntel = context.map_intel || {};
  const includeInitialMap = options.includeInitialMap !== false;
  const includeStableContext = options.includeStableContext !== false;
  const compactContext = {
    ...(includeStableContext ? { protocol: context.protocol } : {}),
    game: context.game,
    game_overview: includeStableContext
      ? compactGameOverview(context.game_overview, includeInitialMap)
      : compactDynamicGameOverview(context.game_overview),
    decision_mode: context.decision_mode,
    decision_brief: context.decision_brief,
    ...(includeStableContext ? { mission: context.mission } : {}),
    // Keep the prompt lean; authoritative rule lookup remains available through
    // the configured read-only tools, while scoring is retained in victory.
    victory: context.victory,
    objectives: context.objectives,
    unit_index: context.unit_index
      ? {
        active: boundedList(context.unit_index.active, 24),
        enemy: boundedList(context.unit_index.enemy, 24)
      }
      : context.unit_index,
    map_intel: compactMapIntel(mapIntel),
    ...(includeStableContext ? { map_topology: context.map_topology } : {}),
    recent_log: boundedList(context.recent_log, 8),
    ...(includeStableContext ? { tools: compactTools(context.tools) } : {}),
    tool_results: boundedList(context.tool_results, 6)
  };
  if (context.phase_intent_catalog) compactContext.phase_intent_catalog = context.phase_intent_catalog;
  if (context.phase_intent) compactContext.phase_intent = context.phase_intent;
  if (context.strategy_execution) compactContext.strategy_execution = context.strategy_execution;
  if (context.strategic_intent) {
    // operation_state already contains the live task plan. Avoid sending a
    // second full goal plan through strategic_intent on every tool round.
    compactContext.strategic_intent = compactStrategicIntent(context.strategic_intent, !context.operation_state);
  }
  if (context.force_allocation) compactContext.force_allocation = context.force_allocation;
  if (context.operation_state) compactContext.operation_state = compactOperationState(context.operation_state);
  if (context.phase_status) compactContext.phase_status = compactPhaseStatus(context.phase_status);
  if (context.rolling_unit_execution) compactContext.rolling_unit_execution = context.rolling_unit_execution;
  if (context.hierarchical_execution) compactContext.hierarchical_execution = context.hierarchical_execution;
  if (context.objective_resolution) compactContext.objective_resolution = context.objective_resolution;
  if (context.movement_memory) compactContext.movement_memory = context.movement_memory;
  if (context.context_persistence) compactContext.context_persistence = context.context_persistence;
  if (Array.isArray(context.candidate_actions)) compactContext.candidate_actions = boundedList(context.candidate_actions, 6);
  if (context.execution_candidate_count != null) compactContext.execution_candidate_count = context.execution_candidate_count;
  return {
    ...(includeStableContext ? {
      provider: payload?.provider,
      model: payload?.model,
      rules_summary: payload?.rules_summary
    } : {}),
    context: compactContext
  };
}

function compactAlternative(item) {
  if (!item || typeof item !== "object") return item;
  const evaluation = item.evaluation || item.assessment?.evaluation || {};
  return {
    action: item.action || item.canonical_action,
    score: item.score ?? item.assessment?.score ?? null,
    reason: item.reason || "",
    evaluation: {
      ...pickDefined(evaluation, ["summary", "start", "destination", "progress", "odds_column"]),
      victory_impact: compactVictoryImpact(evaluation.victory_impact),
      risks: boundedList(evaluation.risks, 4)
    }
  };
}

function compactVictoryImpact(impact) {
  return pickDefined(impact, [
    "self_vp_delta", "opponent_vp_delta", "axis_scoring_threat_delta",
    "supply_risk_delta", "force_preservation_risk", "vp_relevance",
    "crosses_new_scoring_column", "destination_column",
    "projected_supply_after_move", "maintains_july_scoring_supply", "summary"
  ]);
}

function compactAssessment(assessment) {
  if (!assessment || typeof assessment !== "object") return assessment;
  const evaluation = assessment.evaluation || {};
  return {
    ...pickDefined(assessment, ["legal", "score", "reason", "recommended_recovery", "candidate_match"]),
    action: assessment.action,
    evaluation: pickDefined(evaluation, [
      "summary", "start", "destination", "objective", "distance_before", "distance_after",
      "progress", "odds_column", "attack", "defense", "expected_crt_score",
      "enemy_zoc_sources", "enemy_mines", "tactical_tags"
    ]),
    victory_impact: compactVictoryImpact(evaluation.victory_impact),
    risks: boundedList(evaluation.risks, 4)
  };
}

function compactViewMapResult(result) {
  return {
    ...pickDefined(result, [
      "ok", "read_only", "focus", "snapshot", "objectives",
      "current_phase_allowed_actions", "reason", "unit", "hex", "region",
      "battlefield_summary", "map_topology"
    ]),
    actionable_units: boundedList(result.actionable_units, 24),
    recent_rule_rejections: boundedList(result.recent_rule_rejections, 4),
    frontline: boundedList(result.frontline, 12),
    combat_contacts: boundedList(result.combat_contacts, 24),
    minefields: boundedList(result.minefields, 24),
    unit_index: result.unit_index
      ? { active: boundedList(result.unit_index.active, 24), enemy: boundedList(result.unit_index.enemy, 24) }
      : undefined,
    map_intel: result.map_intel ? compactMapIntel(result.map_intel) : undefined
  };
}

function compactToolFeedback(record) {
  const result = record?.result || {};
  let compactResult;
  if (record?.tool === "act") {
    const repairAlternatives = result.alternatives
      || result.assessment?.alternatives
      || result.strategic_review?.alternatives
      || [];
    compactResult = {
      ...pickDefined(result, [
        "accepted", "retryable", "stop", "reason", "rejection_type",
        "repeated_rejection_count", "canonical_action", "instruction",
        "recommended_recovery", "issues"
      ]),
      assessment: compactAssessment(result.assessment),
      strategic_review: result.strategic_review
        ? {
          ...pickDefined(result.strategic_review, ["accept", "issues", "warnings", "exemptions"])
        }
        : undefined,
      alternatives: boundedList(repairAlternatives, 3).map(compactAlternative),
      phase_status: compactPhaseStatus(result.phase_status)
    };
  }
  else if (record?.tool === "view_map") compactResult = compactViewMapResult(result);
  else if (record?.tool === "phase_status") compactResult = compactPhaseStatus(result);
  else if (["hold_unit", "hold_units"].includes(record?.tool)) {
    compactResult = {
      ...pickDefined(result, [
        "accepted", "stop", "unit", "units", "newly_held", "status",
        "phase_complete", "reason", "instruction"
      ]),
      phase_status: compactPhaseStatus(result.phase_status)
    };
  }
  else compactResult = result;
  return { tool: record?.tool, arguments: record?.arguments || {}, result: compactResult };
}

function contextBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

module.exports = {
  CONTEXT_PROFILE_ID,
  compactAgentPayload,
  compactPhaseStatus,
  compactToolFeedback,
  contextBytes
};
