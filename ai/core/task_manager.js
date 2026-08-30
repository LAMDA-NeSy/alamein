"use strict";

const RulesEngine = require("../../rule_engine.js");

const PARENT_STATES = new Set(["planned", "active", "blocked", "completed", "failed", "cancelled"]);
const CHILD_STATES = new Set(["pending", "active", "blocked", "completed", "failed", "skipped"]);
const TASK_TYPES = new Set([
  "preserve_supply",
  "advance",
  "support",
  "protect_flank",
  "joint_attack",
  "clear_blocker",
  "reserve",
  "deny_scoring_frontier",
  "hold_blocking_line",
  "preserve_force",
  "disrupt_axis_supply",
  "counterattack",
  "breakthrough_step"
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeText(value, fallback, limit = 220) {
  const text = String(value || fallback || "").trim();
  return text.slice(0, limit);
}

function taskId(value, fallback) {
  return safeText(value, fallback, 64).replace(/[^a-zA-Z0-9_-]+/g, "_") || fallback;
}

function eligibleUnitIds(state, side) {
  return new Set(Object.entries(state?.units || {})
    .filter(([, unit]) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .map(([id]) => id));
}

function alliedOperationalUnitIds(state) {
  return Object.entries(state?.units || {})
    .filter(([, unit]) => unit.side === "allies" && unit.hex && !unit.eliminated)
    .filter(([, unit]) => RulesEngine.isCombatUnit(unit))
    .map(([id]) => id);
}

function stateScoringFrontier(state, side = "axis") {
  if (side !== "axis") return 34;
  const columns = Object.values(state?.units || {})
    .filter((unit) => unit.side === side && !unit.eliminated && unit.hex && (unit.kind || "ground") === "ground")
    .filter((unit) => ["supplied", "partially_supplied", "partial"].includes(unit.supply_state || unit.supply))
    .map((unit) => Number(String(unit.hex).slice(0, 2)))
    .filter(Number.isFinite);
  return columns.length ? Math.max(34, ...columns) : 34;
}

function axisBreakthroughChildren({ targetColumn, state } = {}) {
  const current = stateScoringFrontier(state, "axis");
  const defaultTarget = state?.scenario === "july" ? 37 : current + 1;
  const firstTarget = state?.scenario === "july" ? 35 : current + 1;
  const target = Math.max(firstTarget, Number(targetColumn) || defaultTarget);
  const children = [];
  for (let column = firstTarget; column <= target && children.length < 6; column += 1) {
    const previous = children.at(-1);
    children.push({
      id: `breakthrough_to_${column}`,
      type: "breakthrough_step",
      title: `带补给推进到第 ${column} 列`,
      priority: column - firstTarget + 1,
      depends_on: previous ? [previous.id] : [],
      target_column: column,
      sequence_index: children.length + 1,
      requires_scoring_supply: true,
      satisfied_at_plan_start: column <= current,
      completion_condition: `至少一个主攻单位以可计分补给状态进入第 ${column} 列`,
      failure_condition: `无法在补给保持有效的情况下推进到第 ${column} 列`,
      required_for_parent: true
    });
  }
  if (children.length < 6) children.push({
    id: "support_spearhead",
    type: "support",
    title: "为突破轴提供支援",
    priority: 20,
    depends_on: [],
    completion_condition: "支援单位接近当前突破阶段",
    failure_condition: "支援单位无法靠近突破轴",
    required_for_parent: false
  });
  if (children.length < 6) children.push({
    id: "protect_flank",
    type: "protect_flank",
    title: "保护突破侧翼和补给线",
    priority: 21,
    depends_on: [],
    completion_condition: "突破轴和补给线没有新增高风险暴露",
    failure_condition: "侧翼或补给线被敌方 ZOC 切断",
    required_for_parent: false
  });
  if (children.length < 6) children.push({
    id: "reserve",
    type: "reserve",
    title: "保留突破预备队",
    priority: 30,
    depends_on: [],
    completion_condition: "预备队保持可用于下一突破阶段",
    failure_condition: "预备队被无目标反复调动",
    required_for_parent: false
  });
  return children;
}

function skeletonChildren(intent = {}) {
  const side = intent.side || intent.goal_plan?.side || "axis";
  if (side === "allies") {
    const children = [
    { id: "deny_scoring_frontier", type: "deny_scoring_frontier", title: "阻断 Axis 计分推进", priority: 1, depends_on: [], completion_condition: "终局时 Axis 有效计分前沿低于防守列", failure_condition: "Axis 有效计分前沿达到或超过防守列" },
    { id: "preserve_supply", type: "preserve_supply", title: "维持 Allied 前线补给", priority: 2, depends_on: [], completion_condition: "关键 Allied 单位保持可补给", failure_condition: "关键 Allied 单位陷入孤立" },
    { id: "preserve_force", type: "preserve_force", title: "保存 Allied 作战单位", priority: 2, depends_on: [], completion_condition: "关键 Allied 作战单位未因孤立或战斗损失", failure_condition: "关键 Allied 作战单位被消灭" },
    { id: "hold_blocking_line", type: "hold_blocking_line", title: "保持防线和封锁位置", priority: 3, depends_on: [], completion_condition: "阻断位置仍能覆盖 Axis 主要推进路线", failure_condition: "防线出现可利用缺口" },
    { id: "disrupt_axis_supply", type: "disrupt_axis_supply", title: "破坏 Axis 补给", priority: 4, depends_on: [], completion_condition: "Axis 前沿补给覆盖下降或推进资格受限", failure_condition: "无法接近或影响 Axis 补给网络" },
    { id: "counterattack", type: "counterattack", title: "执行条件反击", priority: 5, depends_on: [], completion_condition: "反击降低 Axis 计分威胁或清除关键阻塞", failure_condition: "反击风险超过防守收益" }
    ];
    const required = new Set(["deny_scoring_frontier", "preserve_supply", "preserve_force", "hold_blocking_line"]);
    for (const child of children) child.required_for_parent = required.has(child.type);
    return children;
  }
  return axisBreakthroughChildren({
    targetColumn: intent.target_column || intent.goal_plan?.primary_goal?.target_column,
    state: intent.state
  });
}

function buildTaskSkeleton({ intent = {}, operation = "operation", state, side, maxChildTasks = 6 } = {}) {
  const goalPlan = intent.goal_plan || null;
  const primaryGoal = goalPlan?.primary_goal || {};
  const targetColumn = Number(primaryGoal.target_column || intent.target_column || 0);
  const children = skeletonChildren({ ...intent, side, state, target_column: targetColumn || null })
    .slice(0, Math.max(3, Math.min(6, Number(maxChildTasks) || 6)));
  const axisBreakthrough = side === "axis" && children.some((child) => child.type === "breakthrough_step");
  return {
    type: "task_plan",
    protocol: goalPlan ? "side-aware-task-v2" : "hierarchical-task-v1",
    parent: {
      id: taskId(operation, "operation"),
      title: axisBreakthrough ? "完成突破" : safeText(primaryGoal.title || intent.success_condition, "完成当前战略目标", 140),
      objective: safeText(primaryGoal.goal_type || intent.objective_type, "improve the active scoring objective", 120),
      completion_condition: axisBreakthrough
        ? `依次完成所有带补给列级突破任务，最终到达第 ${targetColumn || children.filter((child) => child.type === "breakthrough_step").at(-1)?.target_column} 列`
        : safeText(primaryGoal.observable_conditions?.map((item) => item.description).join("; ") || intent.success_condition, "improve the active scoring objective while preserving supply"),
      failure_condition: safeText(intent.abort_condition, "the operation cannot preserve supply"),
      target_column: Number.isFinite(targetColumn) && targetColumn > 0 ? targetColumn : null,
      subject_side: primaryGoal.subject_side || (side === "allies" ? "axis" : side),
      metric: primaryGoal.metric || (side === "allies" ? "scoring_frontier" : "scenario_scoring"),
      relation: primaryGoal.relation || (side === "allies" ? "keep_below" : "at_least"),
      evaluation_scope: primaryGoal.evaluation_scope || (side === "allies" ? "game_end" : "turn_end"),
      state: "planned",
      started_turn: null,
      started_vp: null
    },
    children: children.map((child) => ({
      ...child,
      ...(child.type === "deny_scoring_frontier" && Number.isFinite(targetColumn) && targetColumn > 0 ? {
        target_column: targetColumn,
        subject_side: "axis",
        metric: "scoring_frontier",
        relation: "keep_below",
        evaluation_scope: "game_end",
        completion_condition: `终局时 Axis 有效计分前沿低于第 ${targetColumn} 列`
      } : {}),
      assigned_units: [],
      progress: 0,
      status: "pending",
      next_action: "等待兵力分配",
      last_blocked_reason: "",
      source: "local_skeleton"
    })),
    side,
    goal_plan: goalPlan,
    state_phase: state?.phase || ""
  };
}

function hasCycle(tasks) {
  const graph = new Map(tasks.map((task) => [task.id, task.depends_on || []]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) if (graph.has(dependency) && visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function normalizeTaskPlan(raw, skeleton, { state, side, allocation, maxChildTasks = 6 } = {}) {
  const source = raw?.task_plan || raw || {};
  const rawParent = source.parent || {};
  const rawChildren = Array.isArray(source.children) ? source.children : [];
  const validUnits = eligibleUnitIds(state, side);
  const allocationUnits = new Set([
    ...(allocation?.spearhead || []).map((item) => item.unit),
    ...(allocation?.support || []).map((item) => item.unit),
    ...(allocation?.supply || []).map((item) => item.unit),
    ...(allocation?.reserve || [])
  ]);
  const skeletonByType = new Map(skeleton.children
    .filter((task) => task.type !== "breakthrough_step")
    .map((task) => [task.type, task]));
  const skeletonById = new Map(skeleton.children.map((task) => [task.id, task]));
  const selected = new Map();
  for (const item of rawChildren) {
    if (!item || typeof item !== "object") continue;
    const type = TASK_TYPES.has(item.type) ? item.type : "";
    const requestedId = taskId(item.id, "");
    const base = type === "breakthrough_step" ? skeletonById.get(requestedId) : skeletonByType.get(type);
    const selectionKey = type === "breakthrough_step" ? base?.id : type;
    if (!base || selected.has(selectionKey)) continue;
    const assigned = Array.isArray(item.assigned_units) ? item.assigned_units : [];
    selected.set(selectionKey, {
      ...base,
      id: type === "breakthrough_step" ? base.id : taskId(item.id, base.id),
      title: safeText(item.title, base.title, 140),
      priority: Math.max(1, Number(item.priority) || base.priority),
      depends_on: type === "breakthrough_step"
        ? [...base.depends_on]
        : Array.isArray(item.depends_on) ? item.depends_on.map(String) : base.depends_on,
      assigned_units: assigned.filter((id, index) => validUnits.has(id) && allocationUnits.has(id) && assigned.indexOf(id) === index),
      subject_side: item.subject_side || base.subject_side || (side === "allies" && ["deny_scoring_frontier", "disrupt_axis_supply"].includes(type) ? "axis" : side),
      metric: item.metric || base.metric || null,
      relation: item.relation || base.relation || null,
      evaluation_scope: item.evaluation_scope || base.evaluation_scope || null,
      completion_condition: safeText(item.completion_condition, base.completion_condition),
      failure_condition: safeText(item.failure_condition, base.failure_condition),
      next_action: safeText(item.next_action, "按当前任务选择下一项合法行动"),
      source: "model"
    });
  }
  for (const base of skeleton.children) {
    const selectionKey = base.type === "breakthrough_step" ? base.id : base.type;
    if (selected.has(selectionKey)) continue;
    selected.set(selectionKey, clone(base));
  }
  const children = skeleton.children
    .map((base) => selected.get(base.type === "breakthrough_step" ? base.id : base.type))
    .filter(Boolean)
    .slice(0, Math.max(3, Math.min(6, Number(maxChildTasks) || 6)));
  const usedUnits = new Set();
  const combatOnlyTypes = new Set(["deny_scoring_frontier", "hold_blocking_line", "preserve_force", "disrupt_axis_supply", "counterattack", "joint_attack", "support", "protect_flank"]);
  const allocationGroups = {
    preserve_supply: (allocation?.supply || []).map((item) => item.unit),
    advance: (allocation?.spearhead || []).map((item) => item.unit),
    breakthrough_step: (allocation?.spearhead || []).map((item) => item.unit),
    support: (allocation?.support || []).map((item) => item.unit),
    protect_flank: (allocation?.reserve || []).map((id) => typeof id === "string" ? id : id.unit),
    joint_attack: (allocation?.spearhead || []).map((item) => item.unit),
    reserve: (allocation?.reserve || []).map((id) => typeof id === "string" ? id : id.unit),
    deny_scoring_frontier: (allocation?.spearhead || []).map((item) => item.unit),
    hold_blocking_line: (allocation?.support || []).map((item) => item.unit),
    preserve_force: (allocation?.reserve || []).map((id) => typeof id === "string" ? id : id.unit),
    disrupt_axis_supply: (allocation?.support || []).map((item) => item.unit),
    counterattack: (allocation?.spearhead || []).map((item) => item.unit)
  };
  const fallbackGround = [...validUnits].filter((id) => (state.units?.[id]?.kind || "ground") !== "supply");
  const fallbackCombat = side === "allies"
    ? alliedOperationalUnitIds(state).filter((id) => validUnits.has(id))
    : fallbackGround;
  const fallbackSupply = [...validUnits]
    .filter((id) => RulesEngine.isSupplyUnit({ id, ...(state.units?.[id] || {}) }));
  if (!allocationGroups.preserve_supply.length) allocationGroups.preserve_supply = fallbackSupply.slice(0, 2);
  if (!allocationGroups.advance.length) allocationGroups.advance = fallbackGround.slice(0, 2);
  if (!allocationGroups.breakthrough_step.length) allocationGroups.breakthrough_step = fallbackGround.slice(0, 2);
  if (!allocationGroups.deny_scoring_frontier.length) allocationGroups.deny_scoring_frontier = fallbackGround.slice(0, 3);
  if (!allocationGroups.hold_blocking_line.length) allocationGroups.hold_blocking_line = fallbackGround.slice(3, 6);
  if (!allocationGroups.preserve_force.length) allocationGroups.preserve_force = fallbackGround.slice(6, 8);
  if (!allocationGroups.support.length) allocationGroups.support = fallbackGround.slice(2, 5);
  if (!allocationGroups.protect_flank.length) allocationGroups.protect_flank = fallbackGround.slice(5, 7);

  // Defensive Allied tracks need disjoint resources. Split the allocator's
  // broad roles before task normalization consumes units for multiple tracks.
  if (side === "allies") {
    const normalizeIds = (items) => [...new Set((items || [])
      .map((item) => typeof item === "string" ? item : item?.unit)
      .filter((id) => validUnits.has(id)))];
    let unitsByHex = {};
    try { unitsByHex = RulesEngine.unitsByHex({ state }); }
    catch { unitsByHex = {}; }
    const tacticalCandidates = fallbackCombat.filter((id) => {
      const unit = state.units?.[id];
      if (!unit?.hex) return false;
      try {
        return RulesEngine.neighbors(unit.hex).some((hex) =>
          (unitsByHex[hex] || []).some((other) =>
            other.side === "axis" && RulesEngine.isCombatUnit(other) && !other.eliminated));
      }
      catch { return false; }
    });
    const claimed = new Set();
    const take = (preferred, count) => {
      const result = [];
      for (const id of [...normalizeIds(preferred).filter((id) => fallbackCombat.includes(id)), ...fallbackCombat]) {
        if (result.length >= count || claimed.has(id)) continue;
        result.push(id);
        claimed.add(id);
      }
      return result;
    };
    const spearhead = normalizeIds(allocation?.spearhead);
    const support = normalizeIds(allocation?.support);
    const reserve = normalizeIds(allocation?.reserve);
    allocationGroups.deny_scoring_frontier = take(spearhead, Math.min(3, Math.max(1, spearhead.length)));
    allocationGroups.preserve_force = take(reserve, 2);
    allocationGroups.hold_blocking_line = take(support, 3);
    allocationGroups.disrupt_axis_supply = take([...tacticalCandidates, ...support, ...reserve], 2);
    allocationGroups.counterattack = take([...tacticalCandidates, ...spearhead, ...support], 2);
    allocationGroups.preserve_supply = normalizeIds(allocation?.supply).filter((id) =>
      RulesEngine.isSupplyUnit({ id, ...(state.units?.[id] || {}) }));
    allocationGroups.reserve = fallbackCombat.filter((id) => !claimed.has(id));
    allocationGroups.joint_attack = [...allocationGroups.counterattack];
    allocationGroups.support = [...allocationGroups.hold_blocking_line];
  }
  const breakthroughUnits = new Set(allocationGroups.breakthrough_step.filter((id) => validUnits.has(id)));
  let breakthroughUnitsClaimed = false;
  for (const child of children) {
    child.compatible_units = ["joint_attack", "counterattack"].includes(child.type)
      ? [...new Set([...(allocationGroups.joint_attack || []), ...(allocationGroups.support || [])])]
        .filter((id) => validUnits.has(id))
      : [];
    if (child.type === "breakthrough_step") {
      child.assigned_units = [...breakthroughUnits];
      if (!breakthroughUnitsClaimed) {
        for (const id of child.assigned_units) usedUnits.add(id);
        breakthroughUnitsClaimed = true;
      }
    }
    else child.assigned_units = child.assigned_units.filter((id) => {
      if (usedUnits.has(id)) return false;
      if (side === "allies" && combatOnlyTypes.has(child.type)
        && !RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) })) return false;
      usedUnits.add(id);
      return true;
    });
    if (!child.assigned_units.length && allocationGroups[child.type]) {
      child.assigned_units = allocationGroups[child.type].filter((id) => {
        if (!validUnits.has(id) || usedUnits.has(id)) return false;
        if (side === "allies" && combatOnlyTypes.has(child.type)
          && !RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) })) return false;
        usedUnits.add(id);
        return true;
      });
    }
    child.status = child.satisfied_at_plan_start ? "completed" : child.depends_on.length ? "pending" : "active";
    child.progress = child.satisfied_at_plan_start ? 1 : 0;
    child.last_blocked_reason = "";
    if (!child.assigned_units.length
      && !(child.type === "joint_attack" && child.compatible_units.length)
      && ["preserve_supply", "advance", "breakthrough_step", "support", "protect_flank", "joint_attack", "deny_scoring_frontier", "hold_blocking_line", "preserve_force", "disrupt_axis_supply", "counterattack"].includes(child.type)) {
      child.status = "blocked";
      child.last_blocked_reason = "no_units_assigned_after_normalization";
    }
  }
  const reserveTask = children.find((child) => child.type === "reserve");
  if (reserveTask) {
    for (const id of validUnits) {
      if (usedUnits.has(id)) continue;
      reserveTask.assigned_units.push(id);
      usedUnits.add(id);
    }
  }
  const ids = new Set(children.map((child) => child.id));
  for (const child of children) child.depends_on = child.depends_on.filter((id) => ids.has(id) && id !== child.id);
  // These task types are preparation or execution tracks. They must be
  // available in parallel; otherwise a model can accidentally require a
  // breakthrough before clearing the blocker or protecting its supply line.
  // Supply preservation is the gate for the main advance. Supporting,
  // screening, clearing, and attack tracks can run in parallel with it.
  const parallelTypes = new Set(["preserve_supply", "support", "protect_flank", "joint_attack", "clear_blocker"]);
  for (const child of children) {
    if (parallelTypes.has(child.type)) child.depends_on = [];
  }
  if (hasCycle(children)) {
    for (const child of children) child.depends_on = [];
    children.sort((left, right) => left.priority - right.priority);
  }
  const parent = {
    ...skeleton.parent,
    id: taskId(rawParent.id, skeleton.parent.id),
    title: safeText(rawParent.title, skeleton.parent.title, 140),
    objective: safeText(rawParent.objective, skeleton.parent.objective, 140),
    completion_condition: safeText(rawParent.completion_condition, skeleton.parent.completion_condition),
    failure_condition: safeText(rawParent.failure_condition, skeleton.parent.failure_condition),
    state: "active",
    started_turn: null,
    started_vp: null,
    source: rawChildren.length ? "model_plus_local_skeleton" : "local_skeleton"
  };
  const targetColumn = Number(skeleton.parent.target_column || 0);
  const denialTask = children.find((task) => task.type === "deny_scoring_frontier");
  if (denialTask && Number.isFinite(targetColumn) && targetColumn > 0) {
    denialTask.target_column = targetColumn;
    denialTask.subject_side = "axis";
    denialTask.metric = "scoring_frontier";
    denialTask.relation = "keep_below";
    denialTask.evaluation_scope = "game_end";
    denialTask.completion_condition = `终局时 Axis 有效计分前沿低于第 ${targetColumn} 列`;
  }
  return {
    type: "task_plan",
    protocol: skeleton.protocol,
    parent,
    children,
    side,
    goal_plan: skeleton.goal_plan || null,
    normalized: true
  };
}

function taskDependenciesComplete(task, children) {
  const byId = new Map(children.map((item) => [item.id, item]));
  return (task.depends_on || []).every((id) => byId.get(id)?.status === "completed");
}

function isTerminalTask(task) {
  return ["completed", "failed", "skipped"].includes(task?.status);
}

function acceptedAttempt(stepRecord) {
  return [...(stepRecord?.action_attempts || [])].reverse().find((item) => item.accepted) || null;
}

function combatOutcomeEvidence(input, stepRecord, acceptedRecord) {
  const action = stepRecord?.final_action || {};
  if (action.type !== "combat") return null;
  const applied = stepRecord?.action_applied?.result?.details || {};
  const effects = applied.effects || {};
  const defenders = new Set(applied.defenders || acceptedRecord?.assessment?.action?.verdict?.details?.defenders || []);
  const attackers = new Set(action.attackers || []);
  const eliminated = new Set(effects.eliminated || []);
  const retreated = new Set(effects.retreated?.retreated || []);
  const defenderLosses = [...defenders].filter((id) => eliminated.has(id));
  const defenderRetreats = [...defenders].filter((id) => retreated.has(id));
  const attackerLosses = [...attackers].filter((id) => eliminated.has(id));
  const attackerRetreats = [...attackers].filter((id) => retreated.has(id));
  const ctx = taskContext(input);
  let defenderSupplyWorsened = [];
  if (ctx?.rules && ctx?.terrain && defenders.size) {
    const defenderSide = input.side === "axis" ? "allies" : "axis";
    let afterSupply = {};
    try { afterSupply = RulesEngine.checkSupply(ctx, defenderSide); }
    catch {}
    const beforeSupply = new Map((acceptedRecord?.assessment?.evaluation?.targets || [])
      .flatMap((target) => target.defenders || [])
      .map((unit) => [unit.id, unit.supply]));
    defenderSupplyWorsened = [...defenders].filter((id) => {
      const before = beforeSupply.get(id);
      const after = afterSupply[id];
      const ranks = { isolated: 0, unsupplied: 1, partial: 2, partially_supplied: 2, supplied: 3 };
      return before && after && (ranks[after] ?? -1) < (ranks[before] ?? -1);
    });
  }
  const targetThreatReduced = defenderLosses.length > 0 || defenderRetreats.length > 0 || defenderSupplyWorsened.length > 0;
  const ownForceHarmed = attackerLosses.length > 0 || attackerRetreats.length > 0;
  return {
    outcome: applied.outcome || applied.raw_outcome || "",
    target_threat_reduced: targetThreatReduced,
    own_force_harmed: ownForceHarmed,
    defender_losses: defenderLosses,
    defender_retreats: defenderRetreats,
    defender_supply_worsened: defenderSupplyWorsened,
    attacker_losses: attackerLosses,
    attacker_retreats: attackerRetreats,
    evidence: [
      ...(defenderLosses.length ? [`enemy eliminated: ${defenderLosses.join(", ")}`] : []),
      ...(defenderRetreats.length ? [`enemy retreated: ${defenderRetreats.join(", ")}`] : []),
      ...(defenderSupplyWorsened.length ? [`enemy supply worsened: ${defenderSupplyWorsened.join(", ")}`] : []),
      ...(attackerLosses.length ? [`own attackers eliminated: ${attackerLosses.join(", ")}`] : []),
      ...(attackerRetreats.length ? [`own attackers retreated: ${attackerRetreats.join(", ")}`] : [])
    ]
  };
}

function oddsRatio(value) {
  const match = String(value || "").match(/^(\d+)\s*[-:]\s*(\d+)$/);
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

function taskContext(input = {}) {
  if (input.ctx?.state) return input.ctx;
  return input.state ? { state: input.state } : null;
}

function isFinalEvaluation(input = {}) {
  const state = input.state || input.ctx?.state || {};
  return state.phase === "end_game_turn"
    && Number(state.turn || input.turn || 0) >= RulesEngine.scenarioFinalTurn(state.scenario);
}

function scoringFrontierForSide(input = {}, side) {
  const ctx = taskContext(input);
  if (!ctx?.state || ctx.state.scenario !== "july" || side !== "axis") return null;
  if (!ctx.rules || !ctx.terrain) return stateScoringFrontier(ctx.state, side);
  const victory = RulesEngine.checkVictory(ctx);
  const advance = victory.breakdown?.find((item) => item.id === "july_east_of_3400");
  return Number(advance?.farthest_column || 34);
}

function alliedDefensePosture(plan, input = {}) {
  if (plan?.side !== "allies") return null;
  const ctx = taskContext(input);
  const state = ctx?.state || input.state || {};
  const frontier = Number(scoringFrontierForSide({ ...input, ctx }, "axis") || 34);
  let currentVp = Number(state.victory_points ?? state.vp ?? 0);
  try {
    if (ctx?.rules && ctx?.terrain) currentVp = Number(RulesEngine.checkVictory(ctx).victory_points || currentVp);
  }
  catch {}
  const campaignGoal = plan.goal_plan?.campaign_goal || {};
  const campaignTarget = Number(campaignGoal.target_vp ?? campaignGoal.target);
  const denialTarget = Number(plan.goal_plan?.primary_goal?.target_column || plan.parent?.target_column || 0);
  const nextColumn = Math.max(35, frontier + 1);
  const columnsUntilCampaignFailure = Number.isFinite(campaignTarget)
    ? Math.max(0, Math.floor((campaignTarget - currentVp) / 3) + 1)
    : null;
  const campaignBreachColumn = columnsUntilCampaignFailure == null
    ? null
    : frontier + columnsUntilCampaignFailure;
  const hardStopColumn = denialTarget > 0 ? denialTarget : null;
  const layers = [...new Set([nextColumn, campaignBreachColumn, hardStopColumn]
    .filter((column) => Number.isFinite(column) && column >= nextColumn)
    .sort((left, right) => left - right))];
  const campaignAlreadyFailed = Number.isFinite(campaignTarget) && currentVp > campaignTarget;
  return {
    protocol: "allied-layered-defense-v1",
    axis_scoring_frontier: frontier,
    current_axis_vp: currentVp,
    campaign_axis_vp_limit: Number.isFinite(campaignTarget) ? campaignTarget : null,
    next_threatened_column: nextColumn,
    campaign_breach_column: campaignBreachColumn,
    hard_stop_column: hardStopColumn,
    defense_layers: layers,
    campaign_status: campaignAlreadyFailed
      ? "campaign_target_already_exceeded"
      : campaignBreachColumn === nextColumn ? "next_axis_gain_breaks_campaign_target" : "campaign_target_on_track",
    priority: campaignAlreadyFailed
      ? `Prevent further Axis scoring at column ${nextColumn}; recover Axis supply/frontier if possible.`
      : `Contest column ${nextColumn} now and preserve a hard blocking line before column ${campaignBreachColumn || hardStopColumn || nextColumn}.`
  };
}

function scenarioScoringFrontier(ctx, side) {
  if (!ctx?.state || ctx.state.scenario !== "july" || side !== "axis") return null;
  const victory = RulesEngine.checkVictory(ctx);
  const advance = victory.breakdown?.find((item) => item.id === "july_east_of_3400");
  const currentColumn = Number(advance?.farthest_column || 34);
  return {
    current_column: currentColumn,
    next_column: Math.max(35, currentColumn + 1),
    vp_gain: 3,
    scoring_requirement: "surviving Axis ground combat unit in the target column with supplied or partially_supplied status"
  };
}

function projectedSupplyAt(ctx, unitId, destination) {
  const unit = ctx?.state?.units?.[unitId];
  if (!unit?.hex || !destination || !RulesEngine.buildSupplyNetwork || !RulesEngine.supplyState) return "unknown";
  const original = unit.hex;
  unit.hex = destination;
  try {
    const network = RulesEngine.buildSupplyNetwork(ctx, unit.side);
    return RulesEngine.supplyState(ctx, unitId, network) || "unknown";
  }
  catch {
    return "unknown";
  }
  finally {
    unit.hex = original;
  }
}

function frontierBreakthroughPlan(plan, input = {}) {
  const ctx = taskContext(input);
  const side = input.side || input.state?.active_side;
  const frontier = scenarioScoringFrontier(ctx, side);
  if (!frontier) return null;
  const activeStep = (plan?.children || [])
    .filter((task) => task.type === "breakthrough_step" && task.status === "active")
    .sort((left, right) => Number(left.target_column || Infinity) - Number(right.target_column || Infinity))[0];
  const requestedTarget = Number(activeStep?.target_column || plan?.parent?.target_column || 0);
  const targetColumn = Math.max(frontier.next_column, Number.isFinite(requestedTarget) && requestedTarget > 0 ? requestedTarget : 0);
  const units = Object.entries(ctx.state.units || {})
    .filter(([, unit]) => unit.side === side && !unit.eliminated && unit.hex && (unit.kind || "ground") === "ground")
    .map(([id, unit]) => ({ id, unit }))
    .filter(({ unit }) => RulesEngine.isCombatUnit({ ...unit }) || RulesEngine.isMapCounter({ ...unit }));
  const direct = [];
  const approach = [];
  for (const { id, unit } of units) {
    let reachable;
    try { reachable = RulesEngine.reachableHexes(ctx, id, { mode: "normal", maxHexes: 120 }); }
    catch { continue; }
    const destinations = [...reachable.entries()]
      .filter(([hex, item]) => hex !== unit.hex && item?.path?.length > 1)
      .map(([hex, item]) => {
        const column = Number(String(hex).slice(0, 2));
        if (!Number.isFinite(column) || column < targetColumn - 1) return null;
        const verdict = RulesEngine.checkMove(ctx, id, item.path, { mode: "normal" });
        if (!verdict.legal) return null;
        const projectedSupply = projectedSupplyAt(ctx, id, hex);
        const zoc = [...RulesEngine.enemyZocSources(ctx, side, hex)];
        const mines = RulesEngine.enemyMinesAt(ctx, side, hex).map((mine) => mine.id);
        const scoringEligible = ["supplied", "partially_supplied", "partial"].includes(projectedSupply);
        const risks = [
          ...(!scoringEligible ? [`projected supply ${projectedSupply}`] : []),
          ...(zoc.length ? [`enemy ZOC from ${zoc.join(", ")}`] : []),
          ...(mines.length ? [`enemy mines ${mines.join(", ")}`] : [])
        ];
        return {
          unit: id,
          from: unit.hex,
          destination: hex,
          path: item.path,
          target_column: column,
          projected_supply: projectedSupply,
          scoring_eligible: scoringEligible,
          risks,
          score: Number(((column >= targetColumn ? 100 : 45) + column * 2 + (scoringEligible ? 35 : -35) - zoc.length * 12 - mines.length * 20).toFixed(2))
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || right.target_column - left.target_column);
    if (!destinations.length) continue;
    const best = destinations[0];
    if (best.target_column >= targetColumn) direct.push(best);
    else approach.push(best);
  }
  direct.sort((left, right) => right.score - left.score);
  approach.sort((left, right) => right.score - left.score);
  const directEligible = direct.filter((item) => item.scoring_eligible);
  const nextStep = directEligible.length
    ? "direct_breakthrough"
    : direct.length
      ? "prepare_supply_or_reduce_risk"
      : approach.length
        ? "prepare_frontier_entry"
        : "reassess_route_or_blocker";
  const preparation = nextStep === "direct_breakthrough"
    ? ["choose a legal direct entry route", "verify projected supply after the move", "recheck the frontier after any combat or supply change"]
    : nextStep === "prepare_supply_or_reduce_risk"
      ? ["move or protect the supply route", "use view_map and inspect_supply to compare entry risks", "reassess the direct entry next phase"]
      : nextStep === "prepare_frontier_entry"
        ? ["move selected units toward the best approach routes", "use check_combat only for blocking contacts", "keep at least one unit ready for the next-column entry"]
        : ["inspect the current map for a new entry axis", "check whether a combat or ZOC blocks every approach", "replan only after confirming the route is infeasible"];
  return {
    protocol: "dynamic-frontier-breakthrough-v1",
    current_column: frontier.current_column,
    target_column: targetColumn,
    vp_gain_at_target: frontier.vp_gain,
    scoring_requirement: frontier.scoring_requirement,
    next_step: nextStep,
    direct_entry_routes: direct.slice(0, 6),
    scoring_eligible_direct_routes: directEligible.slice(0, 4),
    approach_routes: approach.slice(0, 6),
    recommended_unit_ids: [...new Set([...direct, ...approach].slice(0, 6).map((item) => item.unit))],
    preparation_actions: preparation,
    model_freedom: "Routes are locally verified recommendations, not mandatory destinations. The model may use tools to choose another legal route or selective attacker subset."
  };
}

function taskMetrics(task, plan, input = {}) {
  const ctx = taskContext(input);
  const state = ctx?.state || input.state || {};
  const assigned = (task.assigned_units || []).filter((id) => state.units?.[id] && !state.units[id].eliminated);
  let supply = {};
  const observedSide = task.subject_side || plan.side;
  try { if (ctx?.rules && ctx?.terrain) supply = RulesEngine.checkSupply(ctx, observedSide); }
  catch {}
  const supplyState = (id) => supply[id] || state.units?.[id]?.supply_state || state.units?.[id]?.supply || "unknown";
  const supplied = assigned.filter((id) => ["supplied", "partially_supplied"].includes(supplyState(id))).length;
  const columns = assigned.map((id) => Number(String(state.units?.[id]?.hex || "").slice(0, 2))).filter(Number.isFinite);
  const scoringColumns = assigned
    .filter((id) => (state.units?.[id]?.kind || "ground") === "ground")
    .filter((id) => ["supplied", "partially_supplied"].includes(supplyState(id)))
    .map((id) => Number(String(state.units?.[id]?.hex || "").slice(0, 2)))
    .filter(Number.isFinite);
  const globalScoringColumns = Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === observedSide && !unit.eliminated && unit.hex && (unit.kind || "ground") === "ground")
    .filter(([id]) => ["supplied", "partially_supplied"].includes(supplyState(id)))
    .map(([, unit]) => Number(String(unit.hex || "").slice(0, 2)))
    .filter(Number.isFinite);
  const scoringEligibleCount = globalScoringColumns.length;
  const frontierColumn = globalScoringColumns.length ? Math.max(...globalScoringColumns) : null;
  const frontierEligibleCount = frontierColumn == null
    ? 0
    : globalScoringColumns.filter((column) => column === frontierColumn).length;
  const breakthroughTasks = (plan.children || [])
    .filter((item) => item.type === "breakthrough_step" && !isTerminalTask(item))
    .sort((left, right) => (left.status === "active" ? 0 : 1) - (right.status === "active" ? 0 : 1)
      || Number(left.target_column || Infinity) - Number(right.target_column || Infinity));
  const advanceUnits = (breakthroughTasks[0]
    || (plan.children || []).find((item) => item.type === "advance"))?.assigned_units || [];
  const supportDistances = task.type === "support"
    ? assigned.flatMap((id) => advanceUnits.map((targetId) => {
      const left = state.units?.[id]?.hex;
      const right = state.units?.[targetId]?.hex;
      return left && right ? RulesEngine.hexDistance(left, right) : Infinity;
    })).filter(Number.isFinite)
    : [];
  let zocExposed = 0;
  if (ctx?.rules && ctx?.terrain) {
    for (const id of assigned) {
      const unit = state.units?.[id];
      if (unit?.hex && RulesEngine.enemyZocSources(ctx, unit.side, unit.hex).size) zocExposed += 1;
    }
  }
  return {
    assigned: assigned.length,
    supplied,
    farthest_column: columns.length ? Math.max(...columns) : null,
    farthest_scoring_column: scoringColumns.length ? Math.max(...scoringColumns) : null,
    global_farthest_scoring_column: globalScoringColumns.length ? Math.max(...globalScoringColumns) : null,
    scoring_eligible_count: scoringEligibleCount,
    frontier_eligible_count: frontierEligibleCount,
    nearest_support_distance: supportDistances.length ? Math.min(...supportDistances) : null,
    zoc_exposed: zocExposed
  };
}

function reconcileTaskState(plan, input) {
  const changes = [];
  for (const task of plan.children || []) {
    if (isTerminalTask(task)) continue;
    if (task.type === "breakthrough_step" && task.status !== "active") continue;
    const current = taskMetrics(task, plan, input);
    const baseline = task.baseline_metrics || current;
    task.baseline_metrics ||= baseline;
    task.current_metrics = current;
    let progress = Number(task.progress || 0);
    let completed = false;
    let evidence = "";
    if (task.type === "deny_scoring_frontier") {
      const target = Number(task.target_column || plan.parent.target_column || 0);
      const frontier = Number(current.global_farthest_scoring_column || 34);
      const final = isFinalEvaluation(input);
      const breached = target > 0 && frontier >= target;
      progress = breached ? 0 : 1;
      completed = final && !breached;
      task.defensive_status = breached ? "at_risk" : "on_track";
      evidence = `Axis scoring frontier ${frontier}; defended column ${target}; evaluation ${final ? "game_end" : "in_progress"}`;
      if (final) task.status = breached ? "failed" : "completed";
      else if (breached) task.status = "blocked";
    }
    else if (task.type === "preserve_supply" && current.assigned > 0) {
      const baselineCoverage = Number(baseline.scoring_eligible_count || 0);
      const coverageGain = Number(current.scoring_eligible_count || 0) - baselineCoverage;
      const frontierGain = Number(current.frontier_eligible_count || 0) - Number(baseline.frontier_eligible_count || 0);
      progress = Math.max(progress, Math.min(1, current.supplied / current.assigned));
      completed = coverageGain > 0 || frontierGain > 0;
      evidence = `${current.supplied}/${current.assigned} assigned units have scoring-eligible supply; coverage ${current.scoring_eligible_count} (${coverageGain >= 0 ? "+" : ""}${coverageGain}); frontier coverage ${current.frontier_eligible_count}`;
    }
    else if (["advance", "breakthrough_step"].includes(task.type) && (current.farthest_scoring_column ?? current.farthest_column) != null) {
      const currentColumn = current.farthest_scoring_column ?? current.farthest_column;
      const achievedColumn = current.global_farthest_scoring_column ?? currentColumn;
      const baselineColumn = baseline.farthest_scoring_column ?? baseline.farthest_column;
      const target = Number(task.target_column || plan.parent.target_column || baselineColumn + 1);
      task.target_column = target;
      const span = Math.max(1, target - Number(baselineColumn || target - 1));
      progress = Math.max(progress, Math.min(1, (currentColumn - Number(baselineColumn || currentColumn)) / span));
      completed = Number(current.farthest_scoring_column || 0) >= target && current.supplied > 0;
      evidence = `assigned scoring frontier ${currentColumn}; global scoring frontier ${achievedColumn}; target ${target}; supplied ${current.supplied}/${current.assigned}`;
      if (isFinalEvaluation(input) && !completed) task.status = "failed";
    }
    else if (task.type === "support" && current.nearest_support_distance != null) {
      progress = current.nearest_support_distance <= 2 ? 1 : current.nearest_support_distance <= 4 ? 0.5 : 0;
      completed = current.nearest_support_distance <= 2;
      evidence = `nearest support-to-spearhead distance ${current.nearest_support_distance}`;
    }
    else if (task.type === "protect_flank" && current.assigned > 0) {
      progress = current.zoc_exposed === 0 ? 1 : Math.max(0, 1 - current.zoc_exposed / current.assigned);
      completed = current.zoc_exposed === 0;
      evidence = `${current.zoc_exposed}/${current.assigned} flank units exposed to enemy ZOC`;
    }
    else if (task.type === "reserve") {
      task.status = "active";
      task.progress = 0;
      task.progress_evidence = "reserve actions do not complete the parent operation";
      continue;
    }
    task.progress = Number(Math.max(Number(task.progress || 0), progress).toFixed(2));
    task.progress_evidence = evidence;
    if (completed) {
      task.status = "completed";
      changes.push({ task_id: task.id, task_type: task.type, status: "completed", evidence });
    }
  }
  activateTasks(plan, 3, input);
  updateParentState(plan);
  return changes;
}

function updateParentState(plan) {
  const required = (plan.children || []).filter((task) => task.required_for_parent === true);
  if (required.some((task) => task.status === "failed")) {
    plan.parent.state = "failed";
    return false;
  }
  const completed = required.length > 0 && required.every((task) => ["completed", "skipped"].includes(task.status));
  if (completed) plan.parent.state = "completed";
  return completed;
}

function groundedGoalCompleted(plan, input, goal) {
  if (!goal) return { completed: false, evidence: [] };
  const checks = [];
  if (goal.target_column != null && goal.target_column !== "" && Number.isInteger(Number(goal.target_column))) {
    const task = goal.relation === "keep_below"
      ? (plan.children || []).find((item) => item.type === "deny_scoring_frontier")
      : (plan.children || [])
        .filter((item) => item.type === "breakthrough_step" || item.type === "advance")
        .sort((left, right) => Number(right.target_column || 0) - Number(left.target_column || 0))[0];
    const subject = goal.subject_side || plan.side;
    const column = Number(task?.current_metrics?.global_farthest_scoring_column ?? scoringFrontierForSide(input, subject));
    const defensive = ["keep_below", "at_most"].includes(goal.relation);
    const scopeReady = goal.evaluation_scope !== "game_end" || isFinalEvaluation(input);
    checks.push({
      kind: "scoring_frontier",
      subject_side: subject,
      relation: defensive ? "keep_below" : "at_least",
      met: scopeReady && (defensive
        ? column < Number(goal.target_column)
        : column >= Number(goal.target_column)
          && (!task || task.type !== "breakthrough_step" || task.status === "completed")),
      actual: column,
      target: Number(goal.target_column),
      evaluation_scope: goal.evaluation_scope || "turn_end",
      scope_ready: scopeReady
    });
  }
  if (goal.target_vp != null && goal.target_vp !== "" && Number.isInteger(Number(goal.target_vp))) {
    const ctx = taskContext(input);
    let vp = Number(input?.state?.victory_points || 0);
    try { if (ctx?.rules && ctx?.terrain) vp = Number(RulesEngine.checkVictory(ctx).victory_points || 0); }
    catch {}
    const atMost = ["at_most", "keep_below"].includes(goal.relation);
    const scopeReady = goal.evaluation_scope !== "game_end" || isFinalEvaluation(input);
    checks.push({ kind: "victory_points", relation: atMost ? "at_most" : "at_least", met: scopeReady && (atMost ? vp <= Number(goal.target_vp) : vp >= Number(goal.target_vp)), actual: vp, target: Number(goal.target_vp), scope_ready: scopeReady });
  }
  const completed = checks.length > 0 && checks.every((check) => check.met);
  return {
    completed,
    failed: isFinalEvaluation(input) && checks.length > 0 && !completed,
    evidence: checks
  };
}

function groundedRequiredGoalsCompleted(plan, input) {
  const primary = groundedGoalCompleted(plan, input, plan.goal_plan?.primary_goal);
  if (plan.side !== "allies") return primary;
  const campaign = groundedGoalCompleted(plan, input, plan.goal_plan?.campaign_goal);
  const campaignRequired = campaign.evidence.length > 0;
  return {
    completed: primary.completed && (!campaignRequired || campaign.completed),
    failed: primary.failed || (campaignRequired && campaign.failed),
    evidence: [
      ...primary.evidence.map((item) => ({ goal_id: plan.goal_plan?.primary_goal?.id || "primary_goal", ...item })),
      ...campaign.evidence.map((item) => ({ goal_id: plan.goal_plan?.campaign_goal?.id || "campaign_goal", ...item }))
    ],
    partial_success: primary.completed && campaignRequired && !campaign.completed
  };
}

function phaseEligibleSet(input = {}) {
  const state = input.state || input.ctx?.state || {};
  const side = input.side || state.active_side;
  const ctx = input.ctx || { state, rules: input.rules, terrain: input.terrain };
  const kind = RulesEngine.phaseKind(input.phase || state.phase || "");
  return new Set(Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === side && unit.hex && !unit.eliminated)
    .filter(([id, unit]) => kind === "combat"
      ? RulesEngine.canAttackUnit({ id, ...unit }) && (unit.state || "fresh") === "fresh"
        && !unit.attacked_this_turn && !unit.attacked_this_phase
      : RulesEngine.canMoveInCurrentPhase(ctx, { id, ...unit }))
    .map(([id]) => id));
}

function alliedTacticalOpportunities(plan, input = {}) {
  const ctx = taskContext(input);
  if (plan?.side !== "allies" || !ctx?.state) return { counterattack: [], disrupt_axis_supply: [] };
  const state = ctx.state;
  const kind = RulesEngine.phaseKind(input.phase || state.phase || "");
  const eligible = phaseEligibleSet({ ...input, ctx });
  const axisSupply = (() => {
    try { return RulesEngine.checkSupply(ctx, "axis"); }
    catch { return {}; }
  })();
  const axisFrontier = Number(scoringFrontierForSide({ ...input, ctx }, "axis") || 34);
  const taskUnits = (type) => {
    const task = (plan.children || []).find((item) => item.type === type);
    return [...new Set([...(task?.assigned_units || []), ...(task?.compatible_units || [])])]
      .filter((id) => eligible.has(id) && RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) }));
  };
  const result = { counterattack: [], disrupt_axis_supply: [] };

  if (kind === "combat") {
    const byHex = RulesEngine.unitsByHex(ctx);
    const inspect = (type, minimumOdds) => {
      const units = (type === "counterattack"
        ? [...eligible].filter((id) => RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) }))
        : taskUnits(type)).slice(0, 16);
      const targetHexes = [...new Set(units.flatMap((id) => {
        const unit = state.units[id];
        return unit?.hex ? RulesEngine.neighbors(unit.hex).filter((hex) =>
          (byHex[hex] || []).some((enemy) => enemy.side === "axis" && RulesEngine.isCombatUnit(enemy) && !enemy.eliminated)) : [];
      }))];
      const opportunities = [];
      for (const targetHex of targetHexes) {
        const adjacent = units.filter((id) => RulesEngine.neighbors(state.units[id].hex).includes(targetHex));
        const defenderHexes = [...new Set(adjacent.flatMap((id) => RulesEngine.neighbors(state.units[id].hex)
          .filter((hex) => (byHex[hex] || []).some((enemy) => enemy.side === "axis" && RulesEngine.isCombatUnit(enemy) && !enemy.eliminated))))];
        const verdict = RulesEngine.checkCombat(ctx, { attackers: adjacent, defender_hexes: defenderHexes });
        const ratio = oddsRatio(verdict.details?.odds_column);
        if (!verdict.legal || ratio == null || ratio < minimumOdds) continue;
        const defenders = verdict.details.defenders || [];
        const suppliedThreats = defenders.filter((id) => {
          const unit = state.units[id];
          const column = Number(String(unit?.hex || "").slice(0, 2));
          return ["supplied", "partially_supplied", "partial"].includes(axisSupply[id]) && column >= axisFrontier - 1;
        });
        if (!suppliedThreats.length) continue;
        opportunities.push({
          attackers: verdict.details.attackers,
          defender_hexes: verdict.details.defender_hexes,
          odds_column: verdict.details.odds_column,
          supplied_frontier_targets: suppliedThreats,
          reason: "locally verified favorable attack against a supplied Axis frontier threat"
        });
      }
      return opportunities.slice(0, 4);
    };
    result.counterattack = inspect("counterattack", 2);
    result.disrupt_axis_supply = inspect("disrupt_axis_supply", 2);
  }
  else if (["initial_movement", "mechanized_movement"].includes(kind)) {
    const suppliedAxis = Object.entries(state.units || {})
      .filter(([, unit]) => unit.side === "axis" && unit.hex && !unit.eliminated && RulesEngine.isCombatUnit(unit))
      .filter(([id, unit]) => ["supplied", "partially_supplied", "partial"].includes(axisSupply[id])
        && Number(String(unit.hex).slice(0, 2)) >= axisFrontier - 1)
      .map(([id, unit]) => ({ id, hex: unit.hex }));
    result.disrupt_axis_supply = taskUnits("disrupt_axis_supply")
      .map((id) => {
        const unit = state.units[id];
        const nearest = suppliedAxis
          .map((target) => ({ ...target, distance: RulesEngine.hexDistance(unit.hex, target.hex) }))
          .sort((left, right) => left.distance - right.distance)[0];
        return nearest && nearest.distance <= Number(unit.movement || 0) + 3
          ? { unit: id, from: unit.hex, target_unit: nearest.id, target_hex: nearest.hex, distance: nearest.distance, reason: "unit can approach a supplied Axis frontier threat; inspect its supply route before acting" }
          : null;
      })
      .filter(Boolean)
      .slice(0, 4);
  }
  return result;
}

function activateTasks(plan, maxActive = 3, input = null) {
  const children = plan.children || [];
  for (const task of children) {
    if (task.status === "pending" && taskDependenciesComplete(task, children)) task.status = "active";
  }
  if (plan.side === "allies" && input) {
    const defensePosture = alliedDefensePosture(plan, input);
    plan.defensive_posture = defensePosture;
    const opportunities = alliedTacticalOpportunities(plan, input);
    plan.tactical_opportunities = opportunities;
    const phaseKind = RulesEngine.phaseKind(input.phase || input.state?.phase || "");
    const ranked = children
      .filter((task) => !isTerminalTask(task) && taskDependenciesComplete(task, children))
      .map((task) => {
        const opportunityCount = opportunities[task.type]?.length || 0;
        let rank = Number(task.priority || 99) + 10;
        if (task.type === "deny_scoring_frontier") rank = 0;
        else if (task.type === "preserve_supply") rank = phaseKind === "supply_movement" ? 1 : 8;
        else if (task.type === "counterattack") rank = phaseKind === "combat" && opportunityCount ? 1 : 20;
        else if (task.type === "disrupt_axis_supply") rank = opportunityCount ? 2 : 19;
        else if (task.type === "hold_blocking_line") rank = 3;
        else if (task.type === "preserve_force") rank = 4;
        return { task, rank, opportunityCount };
      })
      .sort((left, right) => left.rank - right.rank || left.task.priority - right.task.priority || left.task.id.localeCompare(right.task.id));
    const selected = new Set(ranked.slice(0, Math.max(1, maxActive)).map((item) => item.task.id));
    for (const { task, opportunityCount } of ranked) {
      task.status = selected.has(task.id) ? "active" : "pending";
      task.activation_reason = opportunityCount
        ? `local_rules_found_${opportunityCount}_${task.type}_opportunity`
        : selected.has(task.id) ? "defensive_priority_slot" : "waiting_for_active_slot_or_rule_verified_opportunity";
      task.tactical_opportunities = opportunities[task.type] || [];
      if (task.type === "deny_scoring_frontier") {
        task.operational_target_column = defensePosture?.next_threatened_column || task.target_column;
        task.next_action = defensePosture?.priority || task.next_action;
      }
      if (task.type === "hold_blocking_line" && defensePosture) {
        task.operational_target_column = defensePosture.campaign_breach_column || defensePosture.hard_stop_column;
        task.next_action = `Maintain a supplied blocking line covering Axis routes into columns ${defensePosture.defense_layers.join(", ")}.`;
      }
      if (task.type === "counterattack" && opportunityCount) task.next_action = "使用 check_combat 复核一个已发现的有利反击组合，然后调用 act";
      if (task.type === "disrupt_axis_supply" && opportunityCount) task.next_action = "使用 inspect_supply 和 view_map 核实 Axis 补给瓶颈，然后执行能降低威胁的行动";
      if (["counterattack", "disrupt_axis_supply"].includes(task.type) && !opportunityCount) task.next_action = "等待规则层发现可验证机会";
    }
    return children;
  }
  const active = children.filter((task) => task.status === "active")
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  for (const task of active.slice(maxActive)) task.status = "pending";
  return children;
}

function phaseDispatchTasks(plan, input = {}) {
  const phase = String(input.phase || input.state?.phase || "");
  const phaseKind = RulesEngine.phaseKind(phase);
  const state = input.state || {};
  const side = input.side || state.active_side;
  const context = input.ctx || { state, rules: input.rules, terrain: input.terrain };
  const eligible = new Set(Object.entries(state.units || {})
    .filter(([, unit]) => unit?.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
    .filter(([id, unit]) => phaseKind === "combat"
      ? RulesEngine.isCombatUnit(unit) && unit.state === "fresh" && !unit.attacked_this_turn && !unit.attacked_this_phase
      : RulesEngine.canMoveInCurrentPhase(context, { id, ...unit }))
    .map(([id]) => id));
  const allowedTypes = phaseKind === "combat"
    ? side === "allies"
      ? new Set(["counterattack", "disrupt_axis_supply", "hold_blocking_line", "preserve_force", "deny_scoring_frontier"])
      : new Set(["joint_attack", "clear_blocker", "advance", "breakthrough_step", "support", "protect_flank"])
    : phaseKind === "supply_movement"
      ? new Set(["preserve_supply"])
      : side === "allies"
        ? new Set(["deny_scoring_frontier", "hold_blocking_line", "preserve_force", "disrupt_axis_supply", "counterattack", "preserve_supply", "reserve"])
        : new Set(["advance", "breakthrough_step", "support", "protect_flank", "reserve"]);
  const candidates = (plan?.children || [])
    .filter((task) => task.status === "active" && allowedTypes.has(task.type))
    .map((task) => ({
      task,
      eligible_units: [...new Set([
        ...(task.assigned_units || []),
        ...(task.compatible_units || [])
      ])].filter((id) => eligible.has(id))
    }))
    .filter((item) => item.eligible_units.length)
    .sort((left, right) => left.task.priority - right.task.priority
      || (left.task.status === "active" ? 0 : 1) - (right.task.status === "active" ? 0 : 1)
      || left.task.id.localeCompare(right.task.id));
  const primary = candidates[0] || null;
  const frontierBreakthrough = side === "axis" ? frontierBreakthroughPlan(plan, input) : null;
  return {
    phase_kind: phaseKind,
    rule: "Prefer the highest-priority task that has eligible units in the current phase; keep units assigned to other tasks in reserve unless no current task can act.",
    tasks: candidates.map(({ task, eligible_units }) => ({
      id: task.id,
      type: task.type,
      title: task.title,
      status: task.status,
      priority: task.priority,
      assigned_units: task.assigned_units || [],
      eligible_units,
      tactical_opportunities: task.tactical_opportunities || [],
      activation_reason: task.activation_reason || "",
      next_action: task.next_action,
      completion_condition: task.completion_condition
    })),
    primary_task_id: primary?.task.id || "",
    preferred_units: primary?.eligible_units || [],
    allowed_unit_ids: [...new Set(candidates.flatMap((item) => item.eligible_units))],
    eligible_units_at_phase_start: [...eligible],
    defensive_posture: side === "allies" ? clone(plan?.defensive_posture || alliedDefensePosture(plan, input)) : null,
    frontier_breakthrough: frontierBreakthrough
  };
}

function localTaskProgress(plan, input, stepRecord) {
  const action = stepRecord?.final_action || stepRecord?.action || {};
  const acceptedRecord = acceptedAttempt(stepRecord);
  const accepted = !!acceptedRecord || stepRecord?.final_action_source === "local_fallback";
  if (!accepted || action.type === "pass") return { changed: false, reason: "no_accepted_non_pass_action" };
  const unitIds = new Set(action.unit ? [action.unit] : (action.attackers || []));
  const matching = (plan.children || [])
    .filter((task) => !isTerminalTask(task)
      && (task.assigned_units || []).concat(action.type === "combat" ? task.compatible_units || [] : [])
        .some((id) => unitIds.has(id)))
    .sort((left, right) => (left.status === "active" ? -1 : 1) - (right.status === "active" ? -1 : 1)
      || left.priority - right.priority
      || left.id.localeCompare(right.id));
  if (!matching.length) return { changed: false, reason: "action_unit_not_assigned_to_task" };
  const task = matching[0];
  const statusBefore = task.status;
  if (task.type === "reserve") {
    return {
      changed: false,
      reason: "reserve_action_requires_no_task_progress",
      task_id: task.id,
      task_type: task.type,
      action_matched_inactive_task: false
    };
  }
  if (statusBefore !== "active") {
    return {
      changed: false,
      reason: "action_unit_assigned_to_inactive_task",
      task_id: task.id,
      task_type: task.type,
      action_matched_inactive_task: true
    };
  }
  const evaluation = acceptedRecord?.assessment?.evaluation || {};
  const impact = evaluation.victory_impact || {};
  const combatOutcome = combatOutcomeEvidence(input, stepRecord, acceptedRecord);
  const ratio = oddsRatio(evaluation.odds_column || acceptedRecord?.assessment?.action?.verdict?.details?.odds_column);
  let progress = Number(task.progress || 0);
  let evidence = "";
  let completed = false;
  if (task.type === "joint_attack") {
    const combined = action.type === "combat" && (action.attackers || []).length >= 2;
    if (!combined || ratio == null || ratio < 2) {
      return { changed: false, reason: combined ? "joint_attack_below_two_to_one" : "combat_was_not_joint", task_id: task.id, task_type: task.type };
    }
    progress = 1;
    completed = true;
    evidence = `${action.attackers.length} attackers executed at ${evaluation.odds_column || ratio}`;
  }
  else if (["advance", "breakthrough_step"].includes(task.type)) {
    const positionalGain = Number(evaluation.progress || 0) > 0;
    const scoringGain = Number(impact.estimated_vp_delta || 0) > 0;
    const supplyEligible = impact.maintains_july_scoring_supply === true
      || ["supplied", "partially_supplied"].includes(impact.projected_supply_after_move);
    if ((!positionalGain && !scoringGain) || (task.type === "breakthrough_step" && !supplyEligible)) {
      return { changed: false, reason: supplyEligible ? "move_did_not_advance_objective" : "breakthrough_move_not_scoring_supplied", task_id: task.id, task_type: task.type };
    }
    const achievedColumn = task.type === "breakthrough_step"
      ? Number(taskMetrics(task, plan, input).farthest_scoring_column || 0)
      : scoringFrontierForSide(input, "axis");
    completed = task.type === "breakthrough_step"
      && Number(achievedColumn || 0) >= Number(task.target_column || Infinity);
    progress = completed ? 1 : Math.max(progress, scoringGain ? 0.8 : 0.25);
    evidence = completed
      ? `rule-grounded supplied Axis scoring frontier reached column ${achievedColumn}`
      : scoringGain ? `projected VP gain ${impact.estimated_vp_delta}` : `objective distance improved by ${evaluation.progress}`;
  }
  else if (task.type === "preserve_supply") {
    if (impact.maintains_july_scoring_supply !== true) return { changed: false, reason: "action_did_not_confirm_supply_preservation", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.5);
    evidence = `projected post-action supply ${impact.projected_supply_after_move || "scoring eligible"}`;
  }
  else if (task.type === "support") {
    if (action.type !== "move" || Number(evaluation.progress || 0) <= 0) return { changed: false, reason: "support_did_not_close_distance", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.5);
    evidence = `support move improved objective distance by ${evaluation.progress}`;
  }
  else if (task.type === "protect_flank") {
    if (action.type !== "move" || (evaluation.enemy_zoc_sources || []).length) return { changed: false, reason: "flank_move_remains_exposed", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.5);
    evidence = "flank move avoided enemy ZOC; awaiting next-state confirmation";
  }
  else if (task.type === "deny_scoring_frontier") {
    if (action.type !== "move" && action.type !== "combat") return { changed: false, reason: "denial_task_requires_blocking_or_disruption", task_id: task.id, task_type: task.type };
    const threatDelta = Number(impact.axis_scoring_threat_delta || 0);
    if (threatDelta >= 0 && !combatOutcome?.target_threat_reduced) return { changed: false, reason: "action_did_not_reduce_axis_scoring_threat", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.25);
    evidence = (impact.axis_scoring_threat_evidence || []).join("; ")
      || combatOutcome?.evidence.join("; ")
      || `Axis scoring threat changed by ${threatDelta}`;
  }
  else if (["hold_blocking_line", "preserve_force"].includes(task.type)) {
    if (action.type !== "move") return { changed: false, reason: "defensive_position_not_improved", task_id: task.id, task_type: task.type };
    if (String(impact.force_preservation_risk || "none") !== "none") return { changed: false, reason: "move_has_force_preservation_risk", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.25);
    evidence = "defensive move passed local force-preservation checks";
  }
  else if (task.type === "disrupt_axis_supply") {
    if (action.type !== "move" && action.type !== "combat") return { changed: false, reason: "axis_supply_not_disrupted", task_id: task.id, task_type: task.type };
    const supplyReduced = Number(impact.axis_supply_coverage_delta || 0) < 0 || (combatOutcome?.defender_supply_worsened || []).length > 0;
    if (!supplyReduced) return { changed: false, reason: "axis_supply_not_disrupted", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.5);
    evidence = (impact.axis_scoring_threat_evidence || []).join("; ") || combatOutcome.evidence.join("; ");
  }
  else if (task.type === "counterattack") {
    if (action.type !== "combat" || ratio == null || ratio < 3) return { changed: false, reason: "counterattack_below_three_to_one", task_id: task.id, task_type: task.type };
    if (!combatOutcome?.target_threat_reduced) return { changed: false, reason: "counterattack_did_not_reduce_axis_threat", task_id: task.id, task_type: task.type };
    progress = Math.max(progress, 0.5);
    evidence = `counterattack at ${evaluation.odds_column || ratio}; ${combatOutcome.evidence.join("; ")}`;
  }
  else if (task.type === "clear_blocker") {
    const cleared = action.type === "clear_mine" || (action.type === "combat" && ratio != null && ratio >= 2);
    if (!cleared) return { changed: false, reason: "blocker_not_cleared", task_id: task.id, task_type: task.type };
    progress = 1;
    completed = true;
    evidence = action.type === "clear_mine" ? "mine-clearing action accepted" : `blocker attacked at ${evaluation.odds_column}`;
  }
  else return { changed: false, reason: "task_has_no_local_progress_predicate", task_id: task.id, task_type: task.type };
  task.progress = Number(progress.toFixed(2));
  task.progress_evidence = evidence;
  task.next_action = completed ? "等待下一任务激活" : "等待下一局面确认本次行动结果";
  task.last_action_step = Number(input?.step || 0);
  task.last_action_type = action.type;
  if (completed) task.status = "completed";
  activateTasks(plan, 3, input);
  const parentDone = updateParentState(plan);
  return {
    changed: true,
    task_id: task.id,
    task_type: task.type,
    progress: task.progress,
    evidence,
    status_before: statusBefore,
    action_matched_inactive_task: false,
    parent_completed: parentDone
  };
}

function taskEvents(input, stepRecord, progress) {
  const events = [];
  const action = stepRecord?.final_action || {};
  const accepted = acceptedAttempt(stepRecord);
  const evaluation = accepted?.assessment?.evaluation || {};
  const ratio = oddsRatio(evaluation.odds_column || accepted?.assessment?.action?.verdict?.details?.odds_column);
  const combatOutcome = combatOutcomeEvidence(input, stepRecord, accepted);
  if (action.type === "combat" && (action.attackers || []).length >= 2) events.push("joint_attack");
  if (combatOutcome?.target_threat_reduced) events.push("combat_target_threat_reduced");
  if (combatOutcome?.defender_supply_worsened?.length) events.push("enemy_supply_worsened");
  if (combatOutcome?.own_force_harmed) events.push("own_force_harmed");
  if (accepted && evaluation.victory_impact?.maintains_july_scoring_supply === false) events.push("supply_worsened");
  if (action.type === "combat" && ratio != null && ratio < 2) events.push("low_odds_attack");
  if ((stepRecord?.action_attempts || []).filter((item) => !item.accepted).some((item) => /no legal path|zoc|blocked/i.test(item.reason || ""))) events.push("route_blocked");
  if (stepRecord?.fallback_used) events.push("execution_fallback");
  const heldThisStep = stepRecord?.rolling_unit_action?.held_this_step || [];
  if (heldThisStep.length) events.push("defensive_hold");
  if (input?.side === "allies" && heldThisStep.length >= 3) events.push("excessive_passive_holds");
  const movementPhaseEnded = String(stepRecord?.phase || input?.phase || "").includes("movement") && action.type === "pass";
  const phaseEnded = action.type === "pass";
  if (phaseEnded) events.push("phase_end");
  if (progress?.changed === false && !movementPhaseEnded && !["reserve_action_requires_no_task_progress"].includes(progress.reason)) events.push("no_task_progress");
  if (progress?.parent_completed || progress?.progress >= 1) events.push("task_completed");
  return [...new Set(events)];
}

function checkerEvents(events, progress, consecutiveNoProgress, noProgressThreshold) {
  const immediate = new Set([
    "combat_target_threat_reduced",
    "enemy_supply_worsened",
    "own_force_harmed",
    "supply_worsened",
    "low_odds_attack",
    "route_blocked",
    "execution_fallback",
    "phase_end",
    "task_completed"
  ]);
  const selected = events.filter((event) => immediate.has(event));
  if (events.includes("no_task_progress") && consecutiveNoProgress >= noProgressThreshold) {
    selected.push("repeated_no_task_progress");
  }
  if (progress?.action_matched_inactive_task) selected.push("inactive_task_action");
  return [...new Set(selected)];
}

function createTaskManager({
  maxActiveChildTasks = 3,
  noProgressThreshold = 3,
  blockedThreshold = 2,
  supplyWorsenedThreshold = 2,
  lowOddsThreshold = 2,
  replanCooldownActions = 3,
  passiveHoldThreshold = 3
} = {}) {
  let plan = null;
  let observations = [];
  let replanReason = "";
  let consecutiveNoProgress = 0;
  let noProgressKey = "";
  let consecutiveBlocked = 0;
  let consecutiveSupplyWorsened = 0;
  let consecutiveLowOdds = 0;
  let cooldownActionsRemaining = 0;
  let lastReconciliation = [];
  return {
    get plan() { return plan ? clone(plan) : null; },
    initialize({ intent, operation, input, allocation, rawPlan, preserveParent = false } = {}) {
      const skeleton = buildTaskSkeleton({ intent, operation, state: input?.state, side: input?.side });
      const nextPlan = normalizeTaskPlan(rawPlan, skeleton, { state: input?.state, side: input?.side, allocation });
      if (preserveParent && plan?.parent?.state === "active") {
        nextPlan.parent = {
          ...nextPlan.parent,
          id: plan.parent.id,
          started_turn: plan.parent.started_turn,
          started_vp: plan.parent.started_vp,
          state: plan.parent.state,
          previous_replan_count: Number(plan.parent.previous_replan_count || 0) + 1,
          previous_goal: plan.goal_plan?.primary_goal || null
        };
        const previousByKey = new Map((plan.children || []).map((task) => [
          task.type === "breakthrough_step" ? task.id : task.type,
          task
        ]));
        for (const task of nextPlan.children) {
          const previous = previousByKey.get(task.type === "breakthrough_step" ? task.id : task.type);
          if (!previous) continue;
          const sameTarget = !["advance", "breakthrough_step"].includes(task.type)
            || Number(task.target_column || 0) === Number(previous.target_column || 0);
          task.progress = sameTarget ? Math.max(Number(task.progress || 0), Number(previous.progress || 0)) : 0;
          task.last_action_step = previous.last_action_step;
          task.last_action_type = previous.last_action_type;
          if (sameTarget) task.next_action = previous.next_action || task.next_action;
          if (sameTarget && isTerminalTask(previous)) task.status = previous.status;
        }
      }
      plan = nextPlan;
      plan.parent.started_turn = plan.parent.started_turn ?? Number(input?.turn || 0);
      plan.parent.started_vp = plan.parent.started_vp ?? (input?.state?.vp ?? input?.state?.victory_points ?? null);
      activateTasks(plan, maxActiveChildTasks, input);
      for (const task of plan.children) task.baseline_metrics = taskMetrics(task, plan, input);
      consecutiveNoProgress = 0;
      noProgressKey = "";
      consecutiveBlocked = 0;
      consecutiveSupplyWorsened = 0;
      consecutiveLowOdds = 0;
      cooldownActionsRemaining = preserveParent ? Math.max(0, Number(replanCooldownActions || 0)) : 0;
      lastReconciliation = [];
      return clone(plan);
    },
    refresh(input) {
      if (!plan) return null;
      for (const task of plan.children) {
        task.assigned_units = task.assigned_units.filter((id) => input?.state?.units?.[id] && !input.state.units[id].eliminated);
      }
      lastReconciliation = reconcileTaskState(plan, input);
      const groundedGoals = groundedRequiredGoalsCompleted(plan, input);
      if (groundedGoals.completed) {
        plan.parent.state = "completed";
        plan.parent.goal_completion_evidence = groundedGoals.evidence;
      }
      else if (groundedGoals.failed) {
        plan.parent.state = "failed";
        plan.parent.goal_failure_evidence = groundedGoals.evidence;
      }
      else {
        plan.parent.state = "active";
        plan.parent.goal_progress_evidence = groundedGoals.evidence;
        plan.parent.partial_success = groundedGoals.partial_success === true;
      }
      activateTasks(plan, maxActiveChildTasks, input);
      if (plan.parent.state === "completed") replanReason = "task_goal_completed";
      return clone(plan);
    },
    observe(input, stepRecord) {
      if (!plan) return { progress: null, events: [] };
      const progress = localTaskProgress(plan, input, stepRecord);
      const events = taskEvents(input, stepRecord, progress);
      const heldThisStep = stepRecord?.rolling_unit_action?.held_this_step || [];
      if (plan.side === "allies" && heldThisStep.length >= passiveHoldThreshold && !events.includes("excessive_passive_holds")) {
        events.push("excessive_passive_holds");
      }
      const acceptedNonPass = !!acceptedAttempt(stepRecord) && (stepRecord?.final_action?.type || "") !== "pass";
      if (acceptedNonPass && cooldownActionsRemaining > 0) cooldownActionsRemaining -= 1;
      const activeTask = (plan.children || [])
        .filter((task) => task.status === "active")
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
      const countsAsNoProgress = events.includes("no_task_progress");
      const progressKey = countsAsNoProgress
        ? `${activeTask?.id || plan.parent.id}:${progress.reason || "no_progress"}`
        : "";
      if (!countsAsNoProgress || progressKey !== noProgressKey) {
        consecutiveNoProgress = countsAsNoProgress ? 1 : 0;
        noProgressKey = progressKey;
      }
      else consecutiveNoProgress += 1;
      consecutiveBlocked = events.includes("route_blocked") ? consecutiveBlocked + 1 : 0;
      consecutiveSupplyWorsened = events.includes("supply_worsened") ? consecutiveSupplyWorsened + 1 : 0;
      consecutiveLowOdds = events.includes("low_odds_attack") ? consecutiveLowOdds + 1 : 0;
      const modelCheckEvents = checkerEvents(events, progress, consecutiveNoProgress, noProgressThreshold);
      observations.push({ turn: input?.turn, step: input?.step, events, progress: clone(progress) });
      observations = observations.slice(-256);
      if (cooldownActionsRemaining === 0) {
        if (progress.parent_completed || plan.parent.state === "completed") replanReason = "task_goal_completed";
        else if (events.includes("excessive_passive_holds")) replanReason = "task_excessive_passive_holds";
        else if (consecutiveLowOdds >= lowOddsThreshold) replanReason = "task_repeated_low_odds_attack";
        else if (consecutiveSupplyWorsened >= supplyWorsenedThreshold) replanReason = "task_supply_worsened";
        else if (consecutiveBlocked >= blockedThreshold) replanReason = "task_blocked";
        else if (consecutiveNoProgress >= noProgressThreshold) replanReason = "task_no_progress";
      }
      return {
        progress,
        events,
        checker_events: modelCheckEvents,
        reconciliation: clone(lastReconciliation),
        replan_policy: {
          cooldown_actions_remaining: cooldownActionsRemaining,
          consecutive_no_progress: consecutiveNoProgress,
          consecutive_blocked: consecutiveBlocked,
          consecutive_supply_worsened: consecutiveSupplyWorsened,
          consecutive_low_odds_attacks: consecutiveLowOdds
        },
        plan: clone(plan)
      };
    },
    applyCheck(checkResult) {
      if (!plan || !checkResult?.task_id) return null;
      if (checkResult.abstain || Number(checkResult.confidence || 0) < 0.5) return clone(plan);
      const task = plan.children.find((item) => item.id === checkResult.task_id);
      if (!task) return null;
      task.progress = Math.max(task.progress || 0, Math.min(1, Number(checkResult.task_progress) || 0));
      const supplyEvidence = task.type !== "preserve_supply"
        || Number(task.current_metrics?.scoring_eligible_count || 0) > Number(task.baseline_metrics?.scoring_eligible_count || 0)
        || Number(task.current_metrics?.frontier_eligible_count || 0) > Number(task.baseline_metrics?.frontier_eligible_count || 0);
      // Defensive frontier tasks are intentionally settled by the local
      // end-of-game goal check. A checker can report progress or risk, but it
      // cannot turn an in-progress denial into a completed objective.
      const completionScopeReady = !["deny_scoring_frontier", "breakthrough_step"].includes(task.type);
      if (checkResult.task_status === "completed" && supplyEvidence && completionScopeReady) task.status = "completed";
      else if (checkResult.task_status === "blocked") task.status = "blocked";
      else if (checkResult.task_status === "failed") task.status = "failed";
      if (checkResult.reason) task.last_blocked_reason = checkResult.reason;
      task.checker_campaign_outcome = checkResult.campaign_outcome || "";
      task.checker_local_task_outcome = checkResult.local_task_outcome || "";
      if (checkResult.next_task) task.next_action = `优先推进任务 ${checkResult.next_task}`;
      activateTasks(plan, maxActiveChildTasks);
      updateParentState(plan);
      return clone(plan);
    },
    consumeReplanReason() {
      const value = replanReason;
      replanReason = "";
      return value;
    },
    needsReplan() { return !!replanReason; },
    recentObservations() { return clone(observations); },
    clear() {
      plan = null;
      observations = [];
      replanReason = "";
      consecutiveNoProgress = 0;
      noProgressKey = "";
      consecutiveBlocked = 0;
      consecutiveSupplyWorsened = 0;
      consecutiveLowOdds = 0;
      cooldownActionsRemaining = 0;
      lastReconciliation = [];
    }
  };
}

module.exports = {
  CHILD_STATES,
  PARENT_STATES,
  TASK_TYPES,
  buildTaskSkeleton,
  createTaskManager,
  normalizeTaskPlan,
  phaseDispatchTasks,
  alliedDefensePosture,
  frontierBreakthroughPlan,
  reconcileTaskState,
  taskEvents
};
