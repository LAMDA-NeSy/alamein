"use strict";

const CONTEXT_PROFILE_ID = "compact_current_state_v4_reasoning_memory";

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
  const goalSummary = typeof overview.player_goal_summary === "string"
    ? overview.player_goal_summary.replace(/开局地图是[\s\S]*?。你的任务/, "开局二维地图见 initial_map_reference_2d。你的任务")
    : overview.player_goal_summary;
  return {
    ...pickDefined(overview, [
      "title", "game_type", "current_scenario", "current_side", "objective",
      "turn_goal_update", "player_goal_summary", "player_goal", "victory_decision", "scoring_rules",
      "decision_order", "information_boundaries"
    ]),
    ...(goalSummary !== undefined ? { player_goal_summary: goalSummary } : {}),
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
    persistent_operation: compactPersistentOperation(plan.persistent_operation),
    current_subgoal: compactGoal(plan.current_subgoal),
    campaign_goal: compactGoal(plan.campaign_goal),
    primary_goal: compactGoal(plan.primary_goal),
    supporting_goals: boundedList(plan.supporting_goals, 4).map(compactGoal)
  };
}

function compactPersistentOperation(operation) {
  if (!operation || typeof operation !== "object") return operation;
  return {
    ...pickDefined(operation, ["id", "title", "status", "scenario", "side", "revision", "last_change_reason"]),
    original_goal: operation.original_goal
      ? pickDefined(operation.original_goal, ["campaign_goal", "opening_subgoal", "fixed_evaluation"])
      : null,
    current_subgoal: compactGoal(operation.current_subgoal),
    subgoal_history: boundedList(operation.subgoal_history, 8).map(compactGoal),
    operation_history: boundedList(operation.operation_history, 4)
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
  const result = pickDefined(task, [
    "id", "type", "model_task_type", "title", "priority", "depends_on", "target_column",
    "task_class", "block_conditions", "progress_metric", "progress_value",
    "soft_depends_on", "conditional_dependencies", "dependency_status", "target_hex", "target_region", "target_units",
    "sequence_index", "checkpoint_only", "allows_overshoot", "requires_scoring_supply", "required_for_parent",
    "assigned_units", "compatible_units", "completion_condition", "failure_condition", "phase_scope",
    "progress", "status", "next_action", "last_blocked_reason", "source",
    "execution_blocked", "blocking_mode", "execution_errors", "blocked_targets", "repeat_allowed", "last_execution_error",
    "activation_reason", "tactical_opportunities", "combat_preparation", "preparation_actions",
    "candidate_blockers", "candidate_unit_ids", "activation_policy", "completion_evaluator", "blocker_resolution",
    "task_role", "operation_stage",
    "current_metrics", "progress_evidence", "normalization_corrections",
    "observation_only", "scoring_anchor_state", "scoring_anchor_loss_count", "scoring_anchor_history",
    "completion_criteria", "failure_criteria", "acceptance_contract", "completion_evidence", "checker_assessment", "checker_suggested_switch",
    "wait_state", "review_request", "review_window", "stagnant_windows", "action_window", "acceptance_diagnostics", "target_role"
  ]);
  if (task?.candidate_blockers) result.candidate_blockers = boundedList(task.candidate_blockers, 4);
  if (task?.candidate_unit_ids) result.candidate_unit_ids = boundedList(task.candidate_unit_ids, 12);
  return result;
}

function compactTaskPlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  return {
    ...pickDefined(plan, ["type", "protocol", "side", "normalized", "last_action_feedback", "last_task_events", "review_policy", "monitor_policy", "execution_summary", "breakthrough_access_policy", "breakthrough_planning"]),
    parent: pickDefined(plan.parent, [
      "id", "title", "objective", "completion_condition", "failure_condition",
      "target_column", "subject_side", "metric", "relation", "evaluation_scope",
      "state", "started_turn", "started_vp", "partial_success", "goal_progress_evidence",
      "persistent_operation", "current_subgoal", "operation_revision"
    ]),
    persistent_operation: compactPersistentOperation(plan.persistent_operation),
    current_subgoal: compactGoal(plan.current_subgoal),
    children: boundedList(plan.children, 6).map(compactTask),
    monitors: boundedList(plan.monitors, 6).map(compactTask),
    task_switches: boundedList(plan.task_switches, 8)
  };
}

function compactFrontierBreakthrough(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...pickDefined(value, [
      "protocol", "current_column", "target_column", "minimum_checkpoint_column", "campaign_target_column", "vp_gain_at_target",
      "scoring_requirement", "next_step", "recommended_unit_ids",
      "blocked_route_summary", "preparation_actions", "model_freedom"
    ]),
    best_scoring_routes: boundedList(value.best_scoring_routes, 3),
    ...(!value.best_scoring_routes?.length ? {
      direct_entry_routes: boundedList(value.direct_entry_routes, 3),
      approach_routes: boundedList(value.approach_routes, 3)
    } : {})
  };
}

function compactPhaseDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== "object") return dispatch;
  return {
    ...pickDefined(dispatch, [
      "phase_kind", "rule", "primary_task_id", "preferred_units",
      "allowed_unit_ids", "eligible_units_at_phase_start", "dynamic_spearhead_unit_ids",
      "dynamic_spearhead_reassignment", "execution_source", "tactical_opportunities",
      "upcoming_combat_opportunities", "preparation_actions", "recommended_preparation_unit_ids",
      "blocked_tasks", "breakthrough_planning"
    ]),
    tasks: boundedList(dispatch.tasks, 3).map(compactTask),
    frontier_breakthrough: compactFrontierBreakthrough(dispatch.frontier_breakthrough)
  };
}

function compactTacticalSummary(summary) {
  if (!summary || typeof summary !== "object") return summary;
  return {
    ...pickDefined(summary, [
      "protocol", "side", "opponent", "turn", "phase", "phase_kind",
      "remaining_action_opportunities", "current_vp", "baseline_vp",
      "vp_delta_from_baseline", "next_scoring_change", "must_process_units",
      "can_hold_units", "should_not_act_units", "next_required_task",
      "replanning_trigger", "allocation_corrections", "scoring_recovery", "remaining_phase_windows", "combat_preparation",
      "blocked_tasks", "forbidden_targets", "recent_execution_errors", "required_replanning"
    ]),
    active_tasks: boundedList(summary.active_tasks, 4).map(compactTask),
    scoring_anchor: summary.scoring_anchor ? compactTask(summary.scoring_anchor) : null,
    route_feasibility: boundedList(summary.route_feasibility, 12),
    task_units: boundedList(summary.task_units, 12),
    key_units: boundedList(summary.key_units, 8).map((unit) => ({
      ...pickDefined(unit, ["unit", "position", "attack", "defense", "movement", "supply"]),
      legal_move_options: boundedList(unit.legal_move_options, 4).map((option) => pickDefined(option, [
        "destination", "cost", "destination_column", "enemy_zoc", "mines"
      ]))
    })),
    supply_bottlenecks: boundedList(summary.supply_bottlenecks, 8),
    enemy_threats: boundedList(summary.enemy_threats, 8),
    tactical_opportunities: boundedList(summary.tactical_opportunities, 8),
    last_action_effect: summary.last_action_effect || null,
    task_progress_delta: summary.task_progress_delta || {}
  };
}

function compactOperationState(state) {
  if (!state || typeof state !== "object") return state;
  return {
    ...pickDefined(state, [
      "version", "operation", "target_column", "operation_policy", "status", "target",
      "units", "phase", "phase_kind", "current_vp", "next_required_task", "progress",
      "execution_brief", "warnings", "source", "persistent_operation", "current_subgoal", "operation_revision",
      "task_execution_summary"
    ]),
    tactical_summary: compactTacticalSummary(state.tactical_summary),
    task_plan: compactTaskPlan(state.task_plan),
    active_tasks: boundedList(state.active_tasks, 3).map(compactTask),
    phase_dispatch: compactPhaseDispatch(state.phase_dispatch)
  };
}

function compactPhaseStatus(status) {
  if (!status || typeof status !== "object") return status;
  const compactCombatTarget = (target) => ({
    ...pickDefined(target, [
      "target_hex", "defenders", "defender_strength", "terrain",
      "joint_attack_rule", "has_attack", "required_defender_hexes",
      "recommended_attackers", "recommended_defender_hexes", "recommended_odds",
      "recommendation_reason"
    ]),
    attackers_that_can_attack: boundedList(target.attackers_that_can_attack, 12),
    unavailable_attackers: boundedList(target.unavailable_attackers, 12)
  });
  return {
    ...pickDefined(status, [
      "ok", "read_only", "snapshot", "remaining_units", "unavailable_units",
      "has_legal_non_pass_action", "can_pass", "counts", "advance_reason",
      "combat_target_count", "combat_rules"
    ]),
    remaining_unit_details: boundedList(status.remaining_unit_details, 24),
    mandatory_actions: boundedList(status.mandatory_actions, 8),
    combat_targets: boundedList(status.combat_targets, 12).map(compactCombatTarget)
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

function compactReasoningMemory(memory) {
  if (!memory || typeof memory !== "object") return memory;
  const compactEntry = (entry) => pickDefined(entry, [
    "step", "turn", "phase", "status", "action", "purpose", "summary",
    "reasoning_excerpt", "tool_feedback", "rejected_options", "action_effect",
    "task_progress_delta", "next_intent"
  ]);
  return {
    protocol: memory.protocol || "reasoning-memory-v1",
    policy: memory.policy,
    current: memory.current,
    recent_decisions: boundedList(memory.recent_decisions, 4).map(compactEntry),
    previous_phase_decision: memory.previous_phase_decision
      ? compactEntry(memory.previous_phase_decision) : null,
    last_replan: memory.last_replan || null,
    instructions: boundedList(memory.instructions, 4)
  };
}

function compactAgentPayload(payload, options = {}) {
  const context = payload?.context || {};
  const mapIntel = context.map_intel || {};
  const includeInitialMap = options.includeInitialMap !== false;
  const includeStableContext = options.includeStableContext !== false;
  const compactContext = {
    ...(includeStableContext ? {
      // Tool schemas are already supplied to the harness; this illustrative
      // wrapper only duplicates those schemas in the projected payload.
      protocol: context.protocol && typeof context.protocol === "object"
        ? Object.fromEntries(Object.entries(context.protocol).filter(([key]) => key !== "tool_call_shape"))
        : context.protocol
    } : {}),
    game: context.game,
    game_overview: includeStableContext
      ? compactGameOverview(context.game_overview, includeInitialMap)
      : compactDynamicGameOverview(context.game_overview),
    decision_mode: context.decision_mode,
    // The protocol is the canonical home for scenario policy. Avoid copying
    // the same phase policy into the decision brief for every OpenCode turn.
    decision_brief: context.decision_brief && typeof context.decision_brief === "object"
      ? Object.fromEntries(Object.entries(context.decision_brief).filter(([key]) => key !== "scenario_policy"))
      : context.decision_brief,
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
  if (context.tactical_summary) compactContext.tactical_summary = compactTacticalSummary(context.tactical_summary);
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
  if (context.action_effect) compactContext.action_effect = context.action_effect;
  if (context.task_progress_delta) compactContext.task_progress_delta = context.task_progress_delta;
  if (context.next_intent) compactContext.next_intent = context.next_intent;
  if (context.reasoning_memory) compactContext.reasoning_memory = compactReasoningMemory(context.reasoning_memory);
  if (Array.isArray(context.candidate_actions)) compactContext.candidate_actions = boundedList(context.candidate_actions, 6);
  if (Array.isArray(context.verified_action_options)) {
    compactContext.verified_action_options = boundedList(context.verified_action_options, 8).map(compactAlternative);
  }
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
    ...pickDefined(assessment, ["legal", "score", "reason", "recommended_recovery", "candidate_match", "route_evidence"]),
    action: assessment.action,
    evaluation: pickDefined(evaluation, [
      "summary", "start", "destination", "objective", "distance_before", "distance_after",
      "progress", "odds_column", "attack", "defense", "expected_crt_score",
      "enemy_zoc_sources", "enemy_mines", "tactical_tags", "combat_risk_evidence"
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
