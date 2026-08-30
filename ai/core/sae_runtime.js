"use strict";

const RulesEngine = require("../../rule_engine.js");
const { buildContext, publicPayload, phaseKind } = require("../experiments/external_ai_transcript.js");
const { resolveSidePrompt } = require("./prompt_registry.js");
const { createTaskManager, phaseDispatchTasks } = require("./task_manager.js");
const { goalIntent, groundGoalPlan, localGoalPlan } = require("./goal_manager.js");
const { thinkingRequest } = require("./model_runtime.js");
const { CONTEXT_PROFILE_ID, compactAgentPayload, contextBytes } = require("./agent_context.js");
const crypto = require("node:crypto");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function phaseKey(input) { return `${Number(input.turn)}:${input.side}`; }

function battlefieldFingerprint(input, built = null, options = {}) {
  const state = input?.state || {};
  const side = input?.side || state.active_side || "axis";
  const enemySide = side === "axis" ? "allies" : "axis";
  const enemyUnits = Object.entries(state.units || {})
    .filter(([, unit]) => unit?.side === enemySide)
    .map(([id, unit]) => ({
      id,
      ...(options.includeEnemyPositions === false ? {} : { hex: unit.hex || "" }),
      eliminated: !!unit.eliminated,
      state: unit.state || "",
      status: unit.status || "",
      supply: unit.supply_state || unit.supply || ""
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const control = options.includeControl === false
    ? []
    : Object.entries(state.control || {})
      .filter(([, owner]) => owner)
      .sort(([left], [right]) => left.localeCompare(right));
  const value = {
    side,
    enemy_side: enemySide,
    enemy_units: enemyUnits,
    control,
    current_vp: options.includeVp === false
      ? null
      : (built?.publicContext?.victory?.current_vp
        ?? state.victory_points
        ?? state.vp
        ?? null)
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function balancedJsonCandidates(text) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    }
    else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function parseJsonText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const candidates = [value];
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  candidates.push(...fenced, ...balancedJsonCandidates(value));
  // Reasoning may contain examples before the final answer; use the last valid object.
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
    catch {
      // Continue searching other balanced objects in the reasoning text.
    }
  }
  return null;
}

function parseJson(result, label) {
  const message = result?.response_json?.choices?.[0]?.message || {};
  const content = typeof message.content === "string" ? message.content.trim() : "";
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  if (content) {
    const parsed = parseJsonText(content);
    if (parsed) return { ...parsed, response_source: "content" };
    if (!reasoning) return { error: `${label} invalid JSON in content` };
  }
  if (reasoning) {
    const parsed = parseJsonText(reasoning);
    if (parsed) return { ...parsed, response_source: "reasoning_content" };
    return { error: `${label} invalid JSON in reasoning_content` };
  }
  return { error: `${label} returned empty JSON` };
}

function parsePlanningResponse(result, expectedType, label) {
  const parsed = parseJson(result, label);
  if (parsed.error) return parsed;
  if (expectedType === "strategic_intent" && parsed.type !== expectedType && !parsed.strategic_intent) {
    return { error: `${label} returned ${parsed.type || "an unknown response"}, expected ${expectedType}` };
  }
  if (expectedType === "force_allocation" && parsed.type !== expectedType && !parsed.force_allocation && !parsed.allocation) {
    return { error: `${label} returned ${parsed.type || "an unknown response"}, expected ${expectedType}` };
  }
  if (expectedType === "goal_plan" && !parsed.goal_plan && !parsed.primary_goal && !parsed.campaign_goal && !["open_goal_plan", "strategic_intent"].includes(parsed.type)) {
    return { error: `${label} returned ${parsed.type || "an unknown response"}, expected goal_plan` };
  }
  return parsed;
}

function eligibleUnits(state, side) {
  return Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map(([id, unit]) => ({
      id,
      hex: unit.hex,
      kind: unit.kind || "ground",
      attack: Number(unit.attack || 0),
      defense: Number(unit.defense ?? unit.attack ?? 0),
      movement: Number(unit.movement || 0),
      state: unit.state || "fresh"
    }));
}

function compactAllocationUnits(index = {}) {
  const project = (unit) => ({
    id: unit.id,
    hex: unit.h || unit.hex || "",
    kind: unit.k || unit.kind || "ground",
    attack: Number(unit.a ?? unit.attack ?? 0),
    defense: Number(unit.d ?? unit.defense ?? 0),
    movement: Number(unit.m ?? unit.movement ?? 0),
    state: unit.s || unit.state || "",
    supply: unit.sup || unit.supply || "",
    area: unit.area || ""
  });
  return {
    active: (index.active || []).map(project),
    enemy: (index.enemy || []).map(project)
  };
}

function localAllocation(state, side, intent) {
  const units = eligibleUnits(state, side);
  const combat = units.filter((unit) => unit.kind === "ground")
    .sort((a, b) => b.attack + b.defense - a.attack - a.defense || a.id.localeCompare(b.id));
  const supply = units
    .filter((unit) => RulesEngine.isSupplyUnit({ id: unit.id, ...(state.units?.[unit.id] || unit) }))
    .sort((a, b) => Number(b.movement || 0) - Number(a.movement || 0) || a.id.localeCompare(b.id));
  return {
    type: "force_allocation",
    operation: intent.operation || intent.type || "advance",
    spearhead: combat.slice(0, 2).map((unit) => ({ unit: unit.id, task: "advance toward the scoring objective" })),
    support: combat.slice(2, 5).map((unit) => ({ unit: unit.id, task: "support the spearhead and protect the corridor" })),
    supply: supply.slice(0, 2).map((unit) => ({ unit: unit.id, task: "maintain supply to the spearhead" })),
    reserve: combat.slice(5, 7).map((unit) => unit.id),
    source: "local_fallback"
  };
}

function normalizeIntent(raw, state) {
  const value = raw?.strategic_intent
    || (raw?.intent && typeof raw.intent === "object" ? { ...raw, ...raw.intent } : raw)
    || {};
  const operation = String(value.operation || value.operation_id || "advance").slice(0, 80);
  const targetColumn = Number(value.target_column || value.targetColumn || 0);
  return {
    type: "phase_intent",
    intent: {
      type: ["advance", "pressure", "consolidate", "supply", "attack_pressure", "protect_supply", "pass"].includes(value.intent_type || value.type)
        ? (value.intent_type || value.type) : "advance",
      sector: ["north", "central", "south"].includes(value.sector) ? value.sector : "",
      target_hex: String(value.target_hex || value.targetHex || ""),
      priority_units: Array.isArray(value.priority_units) ? value.priority_units.filter((id) => state.units?.[id]).slice(0, 8) : []
    },
    operation,
    target_column: Number.isFinite(targetColumn) && targetColumn > 0 ? targetColumn : null,
    objective_type: String(value.objective_type || "scoring_frontier").slice(0, 60),
    required_support: Array.isArray(value.required_support) ? value.required_support.slice(0, 4).map(String) : [],
    priorities: Array.isArray(value.priority) ? value.priority.slice(0, 6).map(String) : [],
    abort_condition: String(value.abort_condition || "abort if the operation cannot preserve supply").slice(0, 180),
    success_condition: String(value.success_condition || "improve the active scoring objective while preserving supply").slice(0, 180),
    fallback_condition: String(value.fallback_condition || "replan toward consolidation or supply if the primary route is infeasible").slice(0, 180),
    source: "model"
  };
}

function normalizeAllocation(raw, state, side, intent) {
  const value = raw?.force_allocation || raw?.allocation || raw || {};
  const eligible = eligibleUnits(state, side);
  const valid = new Set(eligible.map((unit) => unit.id));
  const movableSupply = new Set(eligible
    .filter((unit) => RulesEngine.isSupplyUnit({ id: unit.id, ...(state.units?.[unit.id] || unit) }))
    .map((unit) => unit.id));
  const assigned = new Set();
  const readGroup = (key, task) => (Array.isArray(value[key]) ? value[key] : [])
    .map((item) => typeof item === "string" ? { unit: item, task } : { unit: item?.unit, task: item?.task || task })
    .filter((item) => valid.has(item.unit))
    .filter((item) => key === "supply"
      ? movableSupply.has(item.unit)
      : side !== "allies" || RulesEngine.isCombatUnit({ id: item.unit, ...(state.units?.[item.unit] || {}) }))
    .filter((item) => {
      if (assigned.has(item.unit)) return false;
      assigned.add(item.unit);
      return true;
    })
    .slice(0, 12);
  const supplyCorrections = [];
  const requestedSupply = Array.isArray(value.supply) ? value.supply : [];
  for (const item of requestedSupply) {
    const unit = typeof item === "string" ? item : item?.unit;
    if (valid.has(unit) && !movableSupply.has(unit)) supplyCorrections.push({ unit, reason: "removed non-movable supply marker from executable supply task" });
  }
  const allocation = {
    type: "force_allocation",
    operation: intent.operation,
    spearhead: readGroup("spearhead", "advance toward the strategic objective"),
    support: readGroup("support", "support the spearhead"),
    supply: readGroup("supply", "maintain supply to the spearhead"),
    reserve: (Array.isArray(value.reserve) ? value.reserve : [])
      .filter((id) => valid.has(typeof id === "string" ? id : id?.unit))
      .map((id) => typeof id === "string" ? id : id.unit)
      .filter((id) => side !== "allies" || RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) }))
      .filter((id) => !assigned.has(id))
      .filter((id, index, values) => values.indexOf(id) === index)
      .slice(0, 12),
    source: "model"
  };
  for (const id of allocation.reserve) assigned.add(id);
  for (const unit of eligible.filter((item) => !assigned.has(item.id) && item.kind === "ground").slice(0, 2)) {
    allocation.reserve.push(unit.id);
    assigned.add(unit.id);
  }
  const reserveSupplyIndex = allocation.reserve.findIndex((unit) => movableSupply.has(unit));
  if (!allocation.supply.length && reserveSupplyIndex >= 0) {
    const [unit] = allocation.reserve.splice(reserveSupplyIndex, 1);
    allocation.supply.push({ unit, task: "maintain supply to the spearhead" });
    supplyCorrections.push({ unit, reason: "promoted movable supply unit from reserve" });
  }
  if (!allocation.supply.length) {
    const replacement = eligible.find((unit) => movableSupply.has(unit.id) && !assigned.has(unit.id));
    if (replacement) {
      allocation.supply.push({ unit: replacement.id, task: "maintain supply to the spearhead" });
      assigned.add(replacement.id);
      supplyCorrections.push({ unit: replacement.id, reason: "assigned first executable supply unit" });
    }
  }
  allocation.supply_corrections = supplyCorrections;
  allocation.supply_executable_units = [...movableSupply];
  return allocation;
}

function operationState(intent, allocation, input, built, taskPlan = null) {
  const allAssigned = [
    ...allocation.spearhead,
    ...allocation.support,
    ...allocation.supply,
    ...allocation.reserve.map((unit) => ({ unit, task: "reserve" }))
  ];
  const units = Object.fromEntries(allAssigned.map((item) => {
    const id = item.unit || item;
    const unit = input.state.units?.[id];
    return [id, {
      role: allocation.spearhead.some((x) => x.unit === id) ? "spearhead"
        : allocation.support.some((x) => x.unit === id) ? "support"
          : allocation.supply.some((x) => x.unit === id) ? "supply" : "reserve",
      task: item.task || "",
      hex: unit?.hex || ""
    }];
  }));
  const activeTasks = (taskPlan?.children || []).filter((task) => task.status === "active")
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const phaseDispatch = taskPlan ? phaseDispatchTasks(taskPlan, {
    ...input,
    ctx: built.ctx
  }) : null;
  const primaryTask = activeTasks.find((task) => task.id === phaseDispatch?.primary_task_id)
    || activeTasks[0]
    || null;
  return {
    version: taskPlan ? "sae-operation-v2+side-aware-goal-v2" : "sae-operation-v1",
    operation: intent.operation,
    target_column: intent.target_column,
    goal_plan: intent.goal_plan || null,
    operation_policy: intent.goal_plan?.operation_policy || null,
    status: "in_progress",
    target: intent.intent,
    force_allocation: allocation,
    task_plan: taskPlan,
    active_tasks: activeTasks.map((task) => ({
      id: task.id,
      type: task.type,
      title: task.title,
      priority: task.priority,
      assigned_units: task.assigned_units,
      compatible_units: task.compatible_units || [],
      progress: task.progress,
      activation_reason: task.activation_reason || "",
      tactical_opportunities: task.tactical_opportunities || [],
      next_action: task.next_action
    })),
    phase_dispatch: phaseDispatch,
    units,
    phase: input.phase,
    phase_kind: phaseKind(input.phase),
    current_vp: built.publicContext.victory?.current_vp ?? null,
    next_required_task: phaseDispatch?.tasks?.[0]?.next_action
      || taskPlan?.children?.find((task) => task.status === "active")?.next_action
      || (phaseKind(input.phase) === "supply_movement" && allocation.supply.length
      ? `maintain supply with ${allocation.supply[0].unit}`
      : allocation.spearhead.length ? `advance ${allocation.spearhead[0].unit} toward the strategic objective` : "choose a legal action"),
    progress: {
      spearhead_assigned: allocation.spearhead.length,
      support_assigned: allocation.support.length,
      supply_assigned: allocation.supply.length
    },
    execution_brief: primaryTask ? {
      current_task: `${primaryTask.title} (${primaryTask.id})`,
      executable_tasks_this_phase: phaseDispatch?.tasks || [],
      tactical_opportunities: taskPlan?.tactical_opportunities || {},
      observable_gap: primaryTask.progress_evidence || primaryTask.next_action || primaryTask.completion_condition,
      preferred_units: primaryTask.assigned_units || [],
      completion_condition: primaryTask.completion_condition,
      frontier_breakthrough: phaseDispatch?.frontier_breakthrough || null,
      avoid: [
        "Do not use a unit assigned to an inactive task unless the current task is impossible.",
        "Do not accept a move that breaks scoring-eligible supply.",
        input.side === "allies"
          ? "Do not pass over a locally verified 3:1 counterattack against a supplied Axis frontier threat without rechecking it."
          : "Do not repeat a combat below 2:1 without a concrete emergency or VP justification."
      ]
    } : null,
    warnings: [
      "Do not advance a spearhead if projected end-turn supply becomes unsupplied.",
      "The dynamic frontier_breakthrough plan is evidence and sequencing guidance, not a fixed target or mandatory attack combination."
    ],
    source: "sae_runtime"
  };
}

function createSaeRuntime({ config, runtime, client, taskChecker = null, decisionPolicy = "hierarchical_sae" }) {
  const cache = new Map();
  const replanReasons = new Map();
  const taskManager = config.task_management === "multi_task"
    ? createTaskManager({
      maxActiveChildTasks: Number(config.task_management_options?.max_active_child_tasks || 3),
      noProgressThreshold: Number(config.task_management_options?.no_progress_replan_threshold || 3),
      blockedThreshold: Number(config.task_management_options?.blocked_replan_threshold || 2),
      supplyWorsenedThreshold: Number(config.task_management_options?.supply_worsened_replan_threshold || 2),
      lowOddsThreshold: Number(config.task_management_options?.low_odds_replan_threshold || 2),
      replanCooldownActions: Number(config.task_management_options?.replan_cooldown_actions || 3),
      passiveHoldThreshold: Number(config.task_management_options?.passive_hold_replan_threshold || 3)
    })
    : null;
  const openGoalEnabled = !!taskManager && config.task_management_options?.goal_management === "open_grounded";
  let lastPlan = null;
  let pendingTaskCheck = null;
  async function runPendingTaskCheck(input) {
    if (!pendingTaskCheck || !taskChecker || !taskManager) return;
    const pending = pendingTaskCheck;
    pendingTaskCheck = null;
    const checked = await taskChecker.check({
      input,
      taskPlan: taskManager.plan || pending.taskPlan,
      stepRecord: pending.stepRecord,
      events: pending.events
    });
    pending.stepRecord.task_observation ||= {};
    pending.stepRecord.task_observation.check = checked;
    if (!checked.ok) return;
    const localSupplyConflict = pending.events.includes("supply_worsened")
      && checked.result?.supply_preserved === true;
    if (localSupplyConflict) {
      checked.consistency_warning = "checker reported preserved supply while local rule evaluation reported supply_worsened";
      return;
    }
    pending.stepRecord.task_observation.plan = taskManager.applyCheck(checked.result)
      || pending.stepRecord.task_observation.plan;
  }
  async function plan(input) {
    await runPendingTaskCheck(input);
    const key = phaseKey(input);
    const cached = cache.get(key);
    const fingerprintBuilt = buildContext(config, { state: input.state, decisionMode: "hierarchical_sae" });
    const cachedBuilt = fingerprintBuilt;
    // Multi-task plans should survive ordinary enemy movement. Rebuild only
    // when material facts change; the execution context still contains the
    // latest enemy coordinates for tactical decisions.
    const currentFingerprint = battlefieldFingerprint(input, fingerprintBuilt, {
      includeEnemyPositions: !taskManager,
      includeControl: !taskManager,
      includeVp: !taskManager
    });
    const taskReplanReason = taskManager?.needsReplan() ? taskManager.consumeReplanReason() : "";
    const fingerprintChanged = (!!cached?.battlefield_fingerprint && cached.battlefield_fingerprint !== currentFingerprint)
      || (!!lastPlan?.battlefield_fingerprint && lastPlan.battlefield_fingerprint !== currentFingerprint);
    const replanReason = replanReasons.get(key) || taskReplanReason || (fingerprintChanged ? "enemy_state_changed" : "");
    if (replanReason) {
      cache.delete(key);
      replanReasons.delete(key);
    }
    if (cached && !replanReason) {
      const built = cachedBuilt || buildContext(config, { state: input.state, decisionMode: "hierarchical_sae" });
      const refreshed = clone(cached);
      refreshed.reused = true;
      const taskPlan = taskManager?.refresh({ ...input, ctx: built.ctx }) || refreshed.operation_state?.task_plan || null;
      refreshed.operation_state = operationState(refreshed.strategic_intent, refreshed.force_allocation, input, built, taskPlan);
      refreshed.battlefield_fingerprint = currentFingerprint || battlefieldFingerprint(input, built, {
        includeEnemyPositions: !taskManager,
        includeControl: !taskManager,
        includeVp: !taskManager
      });
      refreshed.record = {
        ...refreshed.record,
        reused: true,
        replanned: false,
        replan_reason: "",
        operation: refreshed.operation_state
      };
      return refreshed;
    }
    if (taskManager?.plan && !replanReason && lastPlan
      && (!lastPlan.battlefield_fingerprint || lastPlan.battlefield_fingerprint === currentFingerprint)) {
      const built = buildContext(config, { state: input.state, decisionMode: "hierarchical_sae" });
      const reused = clone(lastPlan);
      const taskPlan = taskManager.refresh({ ...input, ctx: built.ctx });
      reused.reused = true;
      reused.operation_state = operationState(reused.strategic_intent, reused.force_allocation, input, built, taskPlan);
      reused.battlefield_fingerprint = currentFingerprint || battlefieldFingerprint(input, built, {
        includeEnemyPositions: !taskManager,
        includeControl: !taskManager,
        includeVp: !taskManager
      });
      reused.record = {
        ...reused.record,
        reused: true,
        replanned: false,
        replan_reason: "",
        task_plan: taskPlan,
        task_management: "multi_task",
        operation: reused.operation_state
      };
      cache.set(key, reused);
      return reused;
    }
    // Keep the strategic request candidate-free at the action level, while exposing
    // locally evaluated objective routes through objective_resolution.candidates.
    const built = buildContext(config, {
      state: input.state,
      decisionMode: "intent",
      privateCandidates: true
    });
    const payload = publicPayload(config, built.publicContext, []);
    const strategicPayload = compactAgentPayload(payload, { includeInitialMap: false });
    // Planning has no rule-inspection tool, so retain the compact rules brief.
    strategicPayload.context.rules_brief = built.publicContext.rules_brief;
    if (openGoalEnabled) {
      strategicPayload.goal_management = {
        protocol: "side-aware-goal-v2",
        freedom: "The model may propose original goals, combinations, axes, feints, consolidation, or recovery plans.",
        grounding: "Hard facts, VP, supply, legality, units, hexes, and completion evidence are authoritative from the supplied state and are corrected locally.",
        do_not_limit_to: "objective_resolution.candidates"
      };
    }
    let strategicResult;
    let strategic;
    try {
      strategicResult = await client.complete({
        messages: [{ role: "system", content: resolveSidePrompt(input.side, openGoalEnabled ? "external.goal_manager_system" : "external.strategic_planner_system") }, { role: "user", content: JSON.stringify(strategicPayload) }],
        temperature: runtime.profile.defaults.temperature,
        max_tokens: Math.min(Number(config.context?.strategicMaxTokens || 3600), runtime.profile.limits.output),
        response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
        thinking: thinkingRequest(runtime)
      });
      strategic = strategicResult.ok ? parsePlanningResponse(strategicResult, openGoalEnabled ? "goal_plan" : "strategic_intent", "strategic planner") : { error: `model API status ${strategicResult.status}` };
    }
    catch (error) { strategic = { error: error.message }; }
    const goalPlan = openGoalEnabled
      ? strategic.error
        ? localGoalPlan({ publicContext: built.publicContext, state: input.state, side: input.side })
        : groundGoalPlan(strategic, { publicContext: built.publicContext, state: input.state, side: input.side, ctx: built.ctx })
      : null;
    if (goalPlan && strategic.error) goalPlan.source = "local_default";
    const intent = normalizeIntent(goalPlan ? goalIntent(goalPlan) : strategic, input.state);
    if (goalPlan) {
      intent.source = goalPlan.source;
      intent.goal_plan = goalPlan;
      if (goalPlan.grounding?.correction_count) intent.grounding_corrections = goalPlan.grounding.corrections;
    }
    else if (strategic.error) intent.source = "local_default";
    const forcePayload = {
      planning_request: "force_allocation",
      strategic_intent: intent,
      goal_plan: goalPlan,
      current_state: built.publicContext.game,
      units: compactAllocationUnits(built.publicContext.unit_index),
      victory: built.publicContext.victory,
      objective_resolution: built.publicContext.objective_resolution,
      rules_brief: built.publicContext.rules_brief
    };
    let allocationResult;
    let allocation;
    try {
      allocationResult = await client.complete({
        messages: [{ role: "system", content: resolveSidePrompt(input.side, "external.force_allocator_system") }, { role: "user", content: JSON.stringify(forcePayload) }],
        temperature: runtime.profile.defaults.temperature,
        max_tokens: Math.min(Number(config.context?.allocationMaxTokens || 3000), runtime.profile.limits.output),
        response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined,
        thinking: thinkingRequest(runtime)
      });
      allocation = allocationResult.ok ? parsePlanningResponse(allocationResult, "force_allocation", "force allocator") : { error: `model API status ${allocationResult.status}` };
    }
    catch (error) { allocation = { error: error.message }; }
    if (allocation.error) allocation = localAllocation(input.state, input.side, intent);
    else allocation = normalizeAllocation(allocation, input.state, input.side, intent);
    const priorityUnits = allocation.spearhead.concat(allocation.support, allocation.supply).map((item) => item.unit);
    const phaseIntent = {
      ...intent.intent,
      priority_units: priorityUnits.slice(0, 8),
      source: intent.source === "model" ? "sae_strategic_model" : "local_default"
    };
    const taskPlan = taskManager
      ? taskManager.initialize({
        intent,
        operation: intent.operation,
        input: { ...input, ctx: built.ctx },
        allocation,
        rawPlan: goalPlan?.task_plan || strategic,
        preserveParent: !!replanReason && replanReason.startsWith("task_") && replanReason !== "task_goal_completed"
      })
      : null;
    const state = operationState(intent, allocation, input, built, taskPlan);
    const result = {
      phaseIntent,
      strategic_intent: intent,
      goal_plan: goalPlan,
      force_allocation: allocation,
      operation_state: state,
      battlefield_fingerprint: battlefieldFingerprint(input, built, {
        includeEnemyPositions: !taskManager,
        includeControl: !taskManager,
        includeVp: !taskManager
      }),
      record: {
        source: intent.source,
        context_profile: CONTEXT_PROFILE_ID,
        strategic_raw_context_bytes: contextBytes(payload),
        strategic_context_bytes: contextBytes(strategicPayload),
        allocation_context_bytes: contextBytes(forcePayload),
        planning_thinking_mode: runtime.profile.defaults.thinking,
        replanned: !!replanReason,
        replan_reason: replanReason,
        strategic_fallback: intent.source !== "model",
        strategic_fallback_reason: strategic.error || "",
        goal_grounding: goalPlan?.grounding || null,
        allocation_fallback: allocationResult ? allocationResult.ok !== true || allocation.source === "local_fallback" : true,
        allocation_fallback_reason: allocationResult?.error || (allocation.source === "local_fallback" ? "local allocation fallback" : ""),
        strategic: { raw: strategic, status: strategicResult?.status ?? null, elapsed_ms: strategicResult?.elapsed_ms ?? null },
        allocation: { raw: allocationResult?.response_json || allocation, status: allocationResult?.status ?? null, elapsed_ms: allocationResult?.elapsed_ms ?? null },
        task_management: taskManager ? "multi_task" : "disabled",
        task_plan: taskPlan,
        operation: state,
        battlefield_fingerprint: battlefieldFingerprint(input, built, {
          includeEnemyPositions: !taskManager,
          includeControl: !taskManager,
          includeVp: !taskManager
        }),
        reused: false
      }
    };
    cache.set(key, result);
    lastPlan = clone(result);
    return clone(result);
  }
  async function observe(input, stepRecord) {
    if (!stepRecord) return;
    const key = phaseKey(input);
    const rejected = stepRecord.action_attempts || [];
    const pathFailures = rejected.filter((item) => /no legal path found/.test(item.reason || ""));
    const sameTargets = new Map();
    for (const item of pathFailures) {
      const action = item.action || {};
      const target = `${action.unit || ""}:${action.destination || ""}`;
      sameTargets.set(target, (sameTargets.get(target) || 0) + 1);
    }
    const supplyBreak = rejected.some((item) => item.accepted
      && item.assessment?.evaluation?.victory_impact?.maintains_july_scoring_supply === false);
    const repeatedTarget = [...sameTargets.values()].some((count) => count >= 2);
    let taskObservation = null;
    if (taskManager) {
      taskObservation = taskManager.observe(input, stepRecord);
      const checkerEvents = taskObservation.checker_events || taskObservation.events;
      if (taskChecker && checkerEvents.length) pendingTaskCheck = {
        taskPlan: taskObservation.plan,
        stepRecord,
        events: checkerEvents
      };
      stepRecord.task_observation = taskObservation;
      if (taskObservation.events.includes("task_blocked") || taskManager.needsReplan()) {
        replanReasons.set(key, taskManager.consumeReplanReason() || "task_requires_replanning");
      }
    }
    // The task manager owns task-mode recovery. Do not overwrite its reason with
    // the legacy SAE trigger, otherwise a local supply observation replaces the
    // stable parent task with a fresh strategic operation.
    if (!taskManager && !replanReasons.has(key)) {
      if (pathFailures.length >= 2 || repeatedTarget) replanReasons.set(key, "repeated_infeasible_route");
      else if (supplyBreak) replanReasons.set(key, "accepted_move_breaks_scoring_supply");
      else if (stepRecord.fallback_used) replanReasons.set(key, "execution_fallback_requires_reassessment");
    }
  }
  async function finalize(input) {
    await runPendingTaskCheck(input);
    if (!taskManager) return null;
    const built = buildContext(config, { state: input.state, decisionMode: "hierarchical_sae" });
    const taskPlan = taskManager.refresh({ ...input, ctx: built.ctx });
    if (lastPlan) {
      lastPlan.operation_state = operationState(
        lastPlan.strategic_intent,
        lastPlan.force_allocation,
        input,
        built,
        taskPlan
      );
      lastPlan.record = {
        ...lastPlan.record,
        task_plan: taskPlan,
        operation: lastPlan.operation_state
      };
    }
    return clone(taskPlan);
  }
  function clear() { cache.clear(); replanReasons.clear(); taskManager?.clear(); lastPlan = null; pendingTaskCheck = null; }
  return { cache, clear, finalize, observe, plan, replanReasons, taskManager };
}

module.exports = {
  createSaeRuntime,
  localAllocation,
  normalizeAllocation,
  normalizeIntent,
  parsePlanningResponse,
  operationState,
  phaseKey,
  battlefieldFingerprint
};
