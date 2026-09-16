"use strict";

const RulesEngine = require("../../rule_engine.js");
const { fingerprint } = require("./phase_execution_ledger.js");

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
  "breakthrough_step",
  "preserve_scoring_anchor"
]);
const MODEL_TASK_TYPES = new Set([
  "advance", "attack", "defend", "screen", "supply", "recon", "maneuver",
  "isolate", "clear_route", "disrupt", "exploit", "feint", "consolidate",
  "protect", "reserve", "hold_position", "withdraw", "withdrawal", "exit_west",
  "clear_mine", "mine_clearance", "concentrate", "breach", "blocker_reduction", "flank"
]);
const TASK_CLASSES = new Set(["hard", "soft", "conditional"]);
const OPERATION_STAGES = new Set([
  "compress_defense",
  "breach_window",
  "exploit_frontier",
  "consolidate_frontier"
]);
const TASK_ROLES = new Set([
  "recon",
  "concentrate",
  "screen",
  "breach",
  "blocker_reduction",
  "supply",
  "flank",
  "exploit",
  "consolidate",
  "reserve"
]);
const HARD_TASK_TYPES = new Set([
  "preserve_supply", "deny_scoring_frontier", "hold_blocking_line", "preserve_force", "preserve_scoring_anchor"
]);
const CONDITIONAL_TASK_TYPES = new Set([
  "joint_attack", "counterattack", "clear_blocker", "disrupt_axis_supply"
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

function normalizeTaskClass(value, type, options = {}) {
  const normalized = String(value || "").toLowerCase().replace(/[_-]task$/, "");
  if (TASK_CLASSES.has(normalized)) return normalized;
  if (options.conditional === true || CONDITIONAL_TASK_TYPES.has(type)) return "conditional";
  if (HARD_TASK_TYPES.has(type) && options.modelDefined !== true) return "hard";
  return "soft";
}

function defaultProgressMetric(type, modelTaskType = "") {
  const kind = modelTaskType || type;
  if (kind === "preserve_scoring_anchor") return "scoring_frontier_maintenance";
  if (["advance", "breakthrough_step", "exploit", "maneuver"].includes(kind)) return "frontier_or_target_distance";
  if (["preserve_supply", "supply"].includes(kind)) return "supply_coverage";
  if (["withdraw", "withdrawal", "exit_west"].includes(kind)) return "west_exit_progress";
  if (["clear_mine", "mine_clearance"].includes(kind)) return "mine_clearance";
  if (["deny_scoring_frontier", "disrupt_axis_supply", "counterattack", "attack", "disrupt", "isolate"].includes(kind)) return "axis_scoring_threat";
  if (["support", "protect_flank", "screen", "defend", "hold_blocking_line", "preserve_force", "protect", "hold_position"].includes(kind)) return "position_safety";
  if (["clear_blocker", "clear_route"].includes(kind)) return "blocker_reduction";
  if (["joint_attack"].includes(kind)) return "combat_opportunity_conversion";
  return "observable_state_change";
}

function defaultBlockConditions(type, side) {
  if (["preserve_supply", "supply"].includes(type)) return ["assigned key units have no scoring-eligible supply path"];
  if (["advance", "breakthrough_step", "exploit", "maneuver"].includes(type)) return ["no legal route improves the target while preserving the required supply"];
  if (["deny_scoring_frontier", "hold_blocking_line"].includes(type)) return ["Axis has a supplied route through the defended line"];
  if (side === "allies" && ["preserve_force", "protect_flank"].includes(type)) return ["a required Allied unit is isolated or eliminated"];
  return ["the locally verifiable conditions for this task are no longer available"];
}

function modelTaskTitle(type, index) {
  const titles = {
    advance: "推进当前目标区域",
    attack: "利用可验证的攻击机会",
    defend: "稳固防御位置",
    screen: "屏护关键路线",
    supply: "维持关键补给",
    recon: "侦察并确认路线",
    maneuver: "执行机动作战",
    isolate: "隔离敌方单位",
    clear_route: "清理行动路线",
    disrupt: "破坏敌方作战网络",
    exploit: "利用突破窗口",
    feint: "实施牵制机动",
    consolidate: "集结并稳固战果",
    concentrate: "集中突破兵力",
    breach: "形成局部突破",
    blocker_reduction: "降低路线阻挡",
    flank: "保护突破侧翼",
    protect: "保护关键单位",
    reserve: "保留机动预备队",
    hold_position: "保持当前阵地"
  };
  return titles[type] || `模型任务 ${index}`;
}

function normalizeTaskRole(value, modelTaskType) {
  const role = String(value || "").trim().toLowerCase().replace(/[- ]+/g, "_");
  if (role) return safeText(role, "", 64);
  if (TASK_ROLES.has(modelTaskType)) return modelTaskType;
  const inferred = {
    reconnaissance: "recon",
    concentration: "concentrate",
    attack: "breach",
    clear_route: "blocker_reduction",
    clear_blocker: "blocker_reduction",
    protect: "flank",
    advance: "exploit",
    maneuver: "exploit",
    hold_position: "consolidate"
  }[String(modelTaskType || "").toLowerCase()];
  return inferred || "";
}

function normalizeOperationStage(value, role, modelTaskType) {
  const stage = String(value || "").trim().toLowerCase().replace(/[- ]+/g, "_");
  if (OPERATION_STAGES.has(stage)) return stage;
  const inferred = {
    recon: "compress_defense",
    concentrate: "compress_defense",
    screen: "compress_defense",
    supply: "compress_defense",
    flank: "compress_defense",
    reserve: "compress_defense",
    breach: "breach_window",
    blocker_reduction: "breach_window",
    exploit: "exploit_frontier",
    consolidate: "consolidate_frontier",
    attack: "breach_window",
    clear_route: "breach_window",
    advance: "exploit_frontier",
    maneuver: "exploit_frontier"
  }[String(role || modelTaskType || "").toLowerCase()];
  return inferred || "";
}

function julyAxisOperationMetadata() {
  return {
    operation_family: "breakthrough_and_exploit",
    operation_stage: "compress_defense",
    operation_stages: ["compress_defense", "breach_window", "exploit_frontier", "consolidate_frontier"],
    canonical_title: "压缩 Allied 防线并形成可持续突破",
    canonical_objective: "形成可验证的局部突破，并在保持补给、侧翼安全和战斗力的情况下扩大或巩固计分成果",
    canonical_completion_condition: "形成规则可验证的突破，并在保持补给、侧翼安全和战斗力的情况下扩大或巩固计分成果",
    canonical_failure_condition: "无法在可接受的补给、战斗力和路线风险下继续形成或利用突破"
  };
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

function julyScoringAnchorTask() {
  const targetColumn = 35;
  return {
    id: "july_scoring_anchor",
    type: "preserve_scoring_anchor",
    model_task_type: "preserve_scoring_anchor",
    title: "保持 July 有效计分锚点",
    objective: "保持至少一个 Axis 地面作战单位在终局时以有效补给状态位于目标计分列或更东",
    priority: 1,
    observation_only: true,
    depends_on: [],
    soft_depends_on: [],
    conditional_dependencies: [],
    assigned_units: [],
    compatible_units: [],
    task_class: "hard",
    subject_side: "axis",
    metric: "scoring_frontier",
    relation: "at_least",
    target_column: targetColumn,
    evaluation_scope: "game_end",
    completion_condition: `终局时至少一个 Axis 地面作战单位以有效补给状态位于或越过第 ${targetColumn} 列`,
    failure_condition: `终局时 Axis 没有以有效补给状态保持第 ${targetColumn} 列或更东的地面作战单位`,
    acceptance_contract: { mode: "at_settlement", evaluation_scope: "game_end" },
    completion_criteria: { all: [{ id: "scoring_anchor", metric: "scoring_frontier", relation: "at_least",
      subject_side: "axis", target: targetColumn, evaluation_scope: "game_end" }], any: [] },
    required_for_parent: false,
    source: "local_safety_invariant",
    scoring_anchor_state: "approaching",
    scoring_anchor_history: []
  };
}

function axisBreakthroughChildren({ targetColumn, state } = {}) {
  const current = stateScoringFrontier(state, "axis");
  const defaultTarget = current + 1;
  const firstTarget = state?.scenario === "july" ? 35 : current + 1;
  const target = Math.max(firstTarget, Number(targetColumn) || defaultTarget);
  const children = [];
  for (let column = firstTarget; column <= target && children.length < 6; column += 1) {
    const previous = children.at(-1);
    children.push({
      id: `breakthrough_to_${column}`,
      type: "breakthrough_step",
      title: `突破进度检查点：第 ${column} 列`,
      priority: column - firstTarget + 1,
      depends_on: previous ? [previous.id] : [],
      target_column: column,
      sequence_index: children.length + 1,
      checkpoint_only: true,
      allows_overshoot: true,
      requires_scoring_supply: true,
      satisfied_at_plan_start: column <= current,
      completion_condition: `至少一个 Axis 地面作战单位以可计分补给状态到达或越过第 ${column} 列；可由一次纵深移动同时完成多个检查点`,
      failure_condition: `无法在补给保持有效的情况下推进到第 ${column} 列`,
      required_for_parent: true
    });
  }
  if (children.length < 6 && axisHasCombatContact(state, "axis")) children.push({
    id: "clear_blocker",
    type: "clear_blocker",
    title: "清除突破路线上的关键阻挡",
    priority: 10,
    depends_on: [],
    completion_condition: "通过规则验证的战斗或清雷行动降低突破路线阻挡",
    failure_condition: "当前路线阻挡无法在可接受风险下清除",
    required_for_parent: false
  });
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

function axisHasCombatContact(state, side = "axis") {
  if (!state?.units) return false;
  let byHex;
  try { byHex = RulesEngine.unitsByHex({ state }); }
  catch { return false; }
  return Object.values(state.units).some((unit) => unit.side === side
    && unit.hex && !unit.eliminated && RulesEngine.isCombatUnit(unit)
    && RulesEngine.neighbors(unit.hex).some((hex) => (byHex[hex] || []).some((other) =>
      other.side !== side && !other.eliminated && RulesEngine.isCombatUnit(other))));
}

function skeletonChildren(intent = {}) {
  const side = intent.side || intent.goal_plan?.side || "axis";
  const scenario = intent.state?.scenario || intent.goal_plan?.scenario || "july";
  if (side === "allies") {
    if (scenario === "september") {
      return [
        { id: "deny_scoring_frontier", type: "deny_scoring_frontier", title: "阻止 Axis 清雷后形成有效推进", priority: 1, depends_on: [], completion_condition: "终局时 Axis 未通过清雷获得决定性推进", failure_condition: "Axis 清除关键雷区并形成无法阻断的推进路线" },
        { id: "protect_flank", type: "protect_flank", title: "保护 Allied 雷区和防线", priority: 2, depends_on: [], completion_condition: "关键雷区和防线仍能阻碍 Axis 主攻", failure_condition: "关键雷区被清除或防线出现可利用缺口" },
        { id: "preserve_supply", type: "preserve_supply", title: "维持 Allied 前线补给", priority: 3, depends_on: [], completion_condition: "关键 Allied 单位保持可补给", failure_condition: "关键 Allied 单位陷入孤立" },
        { id: "preserve_force", type: "preserve_force", title: "保存 Allied 作战单位", priority: 4, depends_on: [], completion_condition: "关键 Allied 作战单位未因孤立或低收益反击损失", failure_condition: "关键单位被消灭或防线被迫失守" },
        { id: "hold_blocking_line", type: "hold_blocking_line", title: "保持雷区后的封锁线", priority: 5, depends_on: [], completion_condition: "Axis 的清雷路线和突破路线仍受到封锁", failure_condition: "Axis 获得无阻挡突破路线" },
        { id: "counterattack", type: "counterattack", title: "执行有验证收益的条件反击", priority: 6, depends_on: [], completion_condition: "反击降低 Axis 清雷或推进威胁", failure_condition: "反击赔率不足或不能降低威胁" }
      ];
    }
    if (scenario === "october") {
      return [
        { id: "deny_scoring_frontier", type: "deny_scoring_frontier", title: "阻止 Axis 向西撤出", priority: 1, depends_on: [], completion_condition: "终局时 Axis 的西撤 VP 被限制", failure_condition: "Axis 大量高价值单位合法从西边撤出" },
        { id: "hold_blocking_line", type: "hold_blocking_line", title: "封锁 Axis 西撤路线", priority: 2, depends_on: [], completion_condition: "主要西撤路径仍被 Allied 控制或威胁覆盖", failure_condition: "Axis 获得安全的西撤通道" },
        { id: "preserve_force", type: "preserve_force", title: "保存 Allied 防御兵力", priority: 3, depends_on: [], completion_condition: "关键 Allied 作战单位保持可用", failure_condition: "防守单位因无收益行动损失" },
        { id: "disrupt_axis_supply", type: "disrupt_axis_supply", title: "削弱 Axis 撤退前的补给", priority: 4, depends_on: [], completion_condition: "Axis 撤退路线或补给覆盖受到影响", failure_condition: "无法影响 Axis 的撤退准备" },
        { id: "preserve_supply", type: "preserve_supply", title: "维持 Allied 防御补给", priority: 5, depends_on: [], completion_condition: "关键 Allied 防御单位保持可补给", failure_condition: "防御网络持续恶化" },
        { id: "counterattack", type: "counterattack", title: "执行能降低撤退威胁的条件反击", priority: 6, depends_on: [], completion_condition: "反击减少 Axis 西撤能力或清除关键封锁", failure_condition: "反击风险超过防守收益" }
      ];
    }
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
  if (scenario === "september") {
    return [
      { id: "clear_blocker", type: "clear_blocker", title: "清除 Allied 雷区和突破阻挡", priority: 1, depends_on: [], completion_condition: "通过合法清雷或有利战斗降低突破路线阻挡", failure_condition: "雷区或阻挡无法在可接受风险下处理" },
      { id: "preserve_supply", type: "preserve_supply", title: "保持 Axis 突破部队补给", priority: 2, depends_on: [], completion_condition: "突破部队保持可计分补给状态", failure_condition: "主力补给恶化或路线被切断" },
      { id: "support_spearhead", type: "support", title: "为清雷和主攻提供支援", priority: 3, depends_on: [], completion_condition: "支援单位接近清雷或主攻部队", failure_condition: "支援路线不可行" },
      { id: "protect_flank", type: "protect_flank", title: "保护突破侧翼和补给线", priority: 4, depends_on: [], completion_condition: "侧翼和补给线没有新增高风险暴露", failure_condition: "侧翼或补给线被敌方 ZOC 切断" },
      { id: "preserve_force", type: "preserve_force", title: "保存 Axis 作战兵力", priority: 5, depends_on: [], completion_condition: "关键作战单位避免无收益损失", failure_condition: "关键单位在低收益行动中损失" },
      { id: "reserve", type: "reserve", title: "保留机动预备队", priority: 6, depends_on: [], completion_condition: "保留可用于下一阶段的机动单位", failure_condition: "预备队被无目标消耗" }
    ];
  }
  if (scenario === "october") {
    const beforeWithdrawal = Number(intent.state?.turn || 1) <= 10;
    return [
      { id: "preserve_force", type: "preserve_force", title: beforeWithdrawal ? "保持 Axis 部队完整" : "撤出高价值 Axis 作战单位", priority: 1, depends_on: [], completion_condition: beforeWithdrawal ? "第 10 回合前避免无必要损失并保留撤退能力" : "第 10 回合后尽可能将高价值作战单位合法撤出西边", failure_condition: "部队损失或无法保留合法撤退路线" },
      { id: "preserve_supply", type: "preserve_supply", title: "保持 Axis 补给网络", priority: 2, depends_on: [], completion_condition: "关键 Axis 单位保持可补给状态", failure_condition: "补给网络持续恶化" },
      { id: "protect_flank", type: "protect_flank", title: beforeWithdrawal ? "保护撤退路线和侧翼" : "保护西撤路线", priority: 3, depends_on: [], completion_condition: "撤退路线没有新增高风险阻塞", failure_condition: "Allies 封锁主要撤退路线" },
      { id: "support_spearhead", type: "support", title: beforeWithdrawal ? "保持部队可机动" : "支援西侧撤退", priority: 4, depends_on: [], completion_condition: "关键单位具备可验证的合法机动路线", failure_condition: "机动路线连续失败" },
      { id: "reserve", type: "reserve", title: "保留机动预备队", priority: 5, depends_on: [], completion_condition: "保留可响应 Allied 封锁的单位", failure_condition: "预备队被无收益消耗" }
    ];
  }
  return axisBreakthroughChildren({
    targetColumn: intent.target_column || intent.goal_plan?.primary_goal?.target_column,
    state: intent.state
  });
}

function buildTaskSkeleton({ intent = {}, operation = "operation", state, side, maxChildTasks = 6, taskGeneration = "fixed_skeleton", scoringAnchorPolicy = "none" } = {}) {
  const goalPlan = intent.goal_plan || null;
  const primaryGoal = goalPlan?.primary_goal || {};
  const requestedTargetColumn = Number(primaryGoal.target_column
    || (primaryGoal.metric === "scoring_frontier" ? primaryGoal.target : 0)
    || intent.target_column || 0);
  const modelDefined = taskGeneration === "model_defined";
  const julyAxisModelOperation = modelDefined && side === "axis" && state?.scenario === "july";
  const operationMetadata = julyAxisModelOperation ? julyAxisOperationMetadata() : null;
  const targetColumn = requestedTargetColumn || (!modelDefined && side === "axis" && state?.scenario === "july"
    ? stateScoringFrontier(state, "axis") + 1 : 0);
  const taskLimit = Math.max(3, Math.min(6, Number(maxChildTasks) || 6));
  const children = modelDefined ? (scoringAnchorPolicy === "july_terminal_v1" && side === "axis" && state?.scenario === "july"
    ? [julyScoringAnchorTask()] : []) : skeletonChildren({ ...intent, side, state, target_column: targetColumn || null })
    .slice(0, taskLimit);
  const axisBreakthrough = !modelDefined && side === "axis" && children.some((child) => child.type === "breakthrough_step");
  return {
    type: "task_plan",
    protocol: modelDefined ? "model-defined-task-v1" : goalPlan ? "side-aware-task-v3" : "hierarchical-task-v1",
    parent: {
      id: taskId(operation, "operation"),
      title: operationMetadata?.canonical_title || (axisBreakthrough ? "完成突破" : safeText(primaryGoal.title || intent.success_condition, "完成当前战略目标", 140)),
      objective: operationMetadata?.canonical_objective || safeText(primaryGoal.goal_type || intent.objective_type, "improve the active scoring objective", 120),
      completion_condition: operationMetadata?.canonical_completion_condition || (axisBreakthrough
        ? `以可计分补给状态到达或越过第 ${targetColumn || children.filter((child) => child.type === "breakthrough_step").at(-1)?.target_column} 列；中间列仅是进度检查点，不要求逐列停留`
        : safeText(primaryGoal.observable_conditions?.map((item) => item.description).join("; ") || intent.success_condition, "improve the active scoring objective while preserving supply")),
      failure_condition: operationMetadata?.canonical_failure_condition || safeText(intent.abort_condition, "the operation cannot preserve supply"),
      target_column: Number.isFinite(targetColumn) && targetColumn > 0 ? targetColumn : null,
      target_selection_policy: julyAxisModelOperation ? "model_selected_after_breakthrough" : "scenario_specific",
      ...(operationMetadata ? operationMetadata : {}),
      ...(julyAxisModelOperation && rawModelTargetColumn(primaryGoal, intent) ? {
        operational_target_column: rawModelTargetColumn(primaryGoal, intent),
        operational_target_source: "model_selected"
      } : {}),
      target_vp: Number.isFinite(Number(primaryGoal.target_vp ?? goalPlan?.campaign_goal?.target_vp))
        ? Number(primaryGoal.target_vp ?? goalPlan?.campaign_goal?.target_vp)
        : null,
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
      ...(child.type === "deny_scoring_frontier" && state?.scenario === "july" && Number.isFinite(targetColumn) && targetColumn > 0 ? {
        target_column: targetColumn,
        subject_side: "axis",
        metric: "scoring_frontier",
        relation: "keep_below",
        evaluation_scope: "game_end",
        completion_condition: `终局时 Axis 有效计分前沿低于第 ${targetColumn} 列`
      } : {}),
      ...(child.type === "deny_scoring_frontier" && ["september", "october"].includes(state?.scenario) ? {
        target_column: null,
        target: primaryGoal.metric === (state.scenario === "october" ? "withdrawal_vp" : "mine_clearance")
          && primaryGoal.target != null ? Number(primaryGoal.target) : 0,
        subject_side: "axis",
        metric: state.scenario === "october" ? "withdrawal_vp" : "mine_clearance",
        relation: primaryGoal.relation === "keep_below" ? "keep_below" : "at_most",
        evaluation_scope: "game_end"
      } : {}),
      assigned_units: [],
      progress: 0,
      status: "pending",
      next_action: child.observation_only ? "Use current scoring evidence to choose which units, supply routes and tasks to preserve or restore." : "等待兵力分配",
      last_blocked_reason: "",
      source: child.source || "local_skeleton"
    })),
    side,
    goal_plan: goalPlan,
    state_phase: state?.phase || ""
  };
}

function rawModelTargetColumn(primaryGoal = {}, intent = {}) {
  const candidate = primaryGoal.target_column
    ?? (primaryGoal.metric === "scoring_frontier" ? primaryGoal.target : null)
    ?? intent.target_column;
  return candidate != null && candidate !== "" && Number.isFinite(Number(candidate)) && Number(candidate) > 0
    ? Number(candidate) : null;
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
  const modelDefined = skeleton.protocol === "model-defined-task-v1";
  const skeletonByType = new Map(skeleton.children
    .filter((task) => task.type !== "breakthrough_step")
    .map((task) => [task.type, task]));
  const skeletonById = new Map(skeleton.children.map((task) => [task.id, task]));
  const selected = new Map();
  for (const item of rawChildren) {
    if (!item || typeof item !== "object") continue;
    const type = modelDefined
      ? "model_task"
      : TASK_TYPES.has(item.type) ? item.type : "";
    const requestedId = taskId(item.id, modelDefined ? `model_task_${selected.size + 1}` : "");
    const modelTaskType = item.task_type || item.role || item.objective_type || item.type || "custom";
    const assigned = item.assigned_units ?? item.assigned_unit_ids ?? item.units ?? item.responsible_units;
    const dependencies = item.hard_dependencies ?? item.depends_on ?? item.dependencies;
    const normalizedDependencies = normalizeDependencyRefs(dependencies);
    const inferredSoftDependencies = normalizedDependencies.filter((dependency) => dependency.hard === false);
    const hardDependencies = normalizedDependencies.filter((dependency) => dependency.hard !== false);
    const softDependencies = [
      ...inferredSoftDependencies,
      ...normalizeDependencyRefs(item.soft_dependencies ?? item.optional_dependencies ?? [])
        .map((dependency) => ({ ...dependency, hard: false }))
    ];
    const conditionalDependencies = item.conditional_dependencies ?? item.when_dependencies ?? [];
    const completion = item.completion_condition
      || item.observable_completion_condition
      || item.success_condition;
    const failure = item.failure_condition
      || item.observable_failure_condition
      || item.abort_condition;
    const rawAssignedIds = Array.isArray(assigned)
      ? assigned.map((value) => typeof value === "string" ? value : value?.unit || value?.id).filter(Boolean)
      : [];
    const normalizedAssignedIds = [...new Set(rawAssignedIds.filter((id) => validUnits.has(id)
      && (modelDefined || allocationUnits.has(id))))];
    const taskRole = modelDefined
      ? normalizeTaskRole(item.task_role || item.role, modelTaskType)
      : "";
    const operationStage = modelDefined && skeleton.parent.operation_family === "breakthrough_and_exploit"
      ? normalizeOperationStage(item.operation_stage || item.operation_phase, taskRole, modelTaskType)
      : safeText(item.operation_stage || item.operation_phase, "", 64);
    const base = modelDefined
      ? {
        id: requestedId || `model_task_${selected.size + 1}`,
        type: "model_task",
        model_task_type: MODEL_TASK_TYPES.has(modelTaskType) ? modelTaskType : "custom",
        task_role: taskRole,
        operation_stage: operationStage,
        title: safeText(item.title || item.goal || item.purpose, modelTaskTitle(MODEL_TASK_TYPES.has(modelTaskType) ? modelTaskType : "custom", selected.size + 1), 140),
        priority: Math.max(1, Number(item.priority) || selected.size + 1),
        depends_on: hardDependencies.map((dependency) => dependency.id),
        soft_depends_on: softDependencies.map((dependency) => dependency.id),
        conditional_dependencies: normalizeDependencyRefs(conditionalDependencies),
        assigned_units: [],
        compatible_units: [],
        completion_condition: safeText(completion, "模型定义的可观察条件满足"),
        failure_condition: safeText(failure, "模型定义的失败条件满足"),
        required_for_parent: false
      }
      : type === "breakthrough_step" ? skeletonById.get(requestedId) : skeletonByType.get(type);
    const selectionKey = modelDefined ? base?.id : type === "breakthrough_step" ? base?.id : type;
    if (!base || selected.has(selectionKey)) continue;
    const requestedHex = safeText(item.target_hex || (typeof item.target === "string" && /^\d{4}$/.test(item.target) ? item.target : ""), "", 32);
    const targetHex = requestedHex && RulesEngine.onMap(requestedHex) ? RulesEngine.normalizeHex(requestedHex) : "";
    selected.set(selectionKey, {
      ...base,
      id: modelDefined ? base.id : type === "breakthrough_step" ? base.id : taskId(item.id, base.id),
      title: safeText(item.title, base.title, 140),
      priority: Math.max(1, Number(item.priority) || base.priority),
      depends_on: type === "breakthrough_step"
        ? [...base.depends_on]
        : Array.isArray(dependencies) ? hardDependencies.map((dependency) => dependency.id) : base.depends_on,
      soft_depends_on: modelDefined
        ? softDependencies.map((dependency) => dependency.id)
        : [...(base.soft_depends_on || [])],
      conditional_dependencies: modelDefined
        ? normalizeDependencyRefs(conditionalDependencies)
        : [...(base.conditional_dependencies || [])],
      assigned_units: normalizedAssignedIds,
      task_class: normalizeTaskClass(item.task_class || item.class, modelDefined ? modelTaskType : type, { modelDefined }),
      block_conditions: Array.isArray(item.block_conditions)
        ? item.block_conditions.map((condition) => safeText(condition, "", 180)).filter(Boolean).slice(0, 6)
        : defaultBlockConditions(modelDefined ? modelTaskType : type, side),
      progress_metric: safeText(item.progress_metric || item.progress_measure, defaultProgressMetric(modelDefined ? "model_task" : type, modelDefined ? modelTaskType : ""), 80),
      progress_value: 0,
      progress_evidence: "等待首次基于局面事实的进度评估",
      subject_side: ["mine_clearance", "withdrawal_vp"].includes(item.metric || base.metric)
        ? "axis"
        : item.subject_side || base.subject_side || (side === "allies" && ["deny_scoring_frontier", "disrupt_axis_supply"].includes(type) ? "axis" : side),
      metric: item.metric || base.metric || null,
      relation: item.relation || base.relation || null,
      evaluation_scope: item.evaluation_scope || base.evaluation_scope || null,
      completion_condition: safeText(completion, base.completion_condition),
      failure_condition: safeText(failure, base.failure_condition),
      acceptance_contract: item.acceptance_contract ? clone(item.acceptance_contract) : null,
      completion_criteria: normalizeObservableCriteria(item.completion_criteria
        || item.observable_completion
        || item.completion_predicate),
      failure_criteria: normalizeObservableCriteria(item.failure_criteria
        || item.observable_failure
        || item.failure_predicate),
      next_action: safeText(item.next_action, "按当前任务选择下一项合法行动"),
      model_task_type: modelDefined ? base.model_task_type : undefined,
      task_role: modelDefined ? base.task_role : undefined,
      operation_stage: modelDefined ? base.operation_stage : undefined,
      phase_scope: Array.isArray(item.applicable_phases || item.phases || item.phase_scope)
        ? (item.applicable_phases || item.phases || item.phase_scope).map(String).slice(0, 8)
        : [],
      target_column: item.target_column != null && item.target_column !== "" && Number.isFinite(Number(item.target_column)) ? Number(item.target_column) : base?.target_column,
      target_column_source: item.target_column != null && item.target_column !== ""
        ? "model_selected" : base?.target_column != null ? "inherited_goal" : "none",
      target_selection_policy: modelDefined && state?.scenario === "july" && side === "axis"
        ? "model_selected_after_breakthrough" : "scenario_specific",
      target_vp: item.target_vp != null && item.target_vp !== "" && Number.isFinite(Number(item.target_vp)) ? Number(item.target_vp) : base?.target_vp,
      target: item.target ?? base?.target,
      target_hex: targetHex,
      target_region: safeText(item.target_region || item.region, "", 100),
      target_units: Array.isArray(item.target_units) ? item.target_units.map(String).slice(0, 24) : [],
      raw_model_task: modelDefined ? clone(item) : undefined,
      source: "model",
      normalization_corrections: [
        ...(requestedHex && !targetHex ? [{ field: "target_hex", requested: requestedHex, grounded: "", correction: "invalid_hex_removed" }] : []),
        ...(modelDefined ? [
        ...(!item.title && !item.goal && !item.purpose ? [{ field: "title", correction: "generated_from_task_type" }] : []),
        ...(MODEL_TASK_TYPES.has(modelTaskType) ? [] : [{ field: "task_type", correction: "mapped_to_custom" }]),
        ...(taskRole ? [] : [{ field: "task_role", correction: "role_not_declared_or_inferred" }]),
        ...(operationStage ? [] : [{ field: "operation_stage", correction: "stage_not_declared_or_inferred" }]),
        ...(rawAssignedIds.length !== normalizedAssignedIds.length ? [{
          field: "assigned_units",
          correction: "removed_unknown_duplicate_or_unavailable_units",
          removed: rawAssignedIds.filter((id) => !normalizedAssignedIds.includes(id)).slice(0, 12)
        }] : [])
        ] : [])
      ]
    });
  }
  if (modelDefined && !selected.size) {
    const fallbackId = taskId(`${skeleton.parent.id}_execution`, "model_task_execution");
    const goal = skeleton.goal_plan?.primary_goal || {};
    const goalTarget = goal.target ?? goal.target_column ?? goal.target_vp ?? null;
    const goalCriteria = goal.metric && goalTarget != null ? {
      all: [{ metric: goal.metric, relation: goal.relation || "at_least", target: goalTarget,
        subject_side: goal.subject_side || side, evaluation_scope: goal.evaluation_scope || "turn_end" }]
    } : null;
    const fallbackType = goal.metric === "mine_clearance" ? "clear_mine"
      : goal.metric === "withdrawal_vp" ? "withdrawal"
        : goal.metric === "scoring_frontier" ? (side === "allies" ? "defend" : "advance") : "consolidate";
    selected.set(fallbackId, {
      id: fallbackId,
      type: "model_task",
      model_task_type: fallbackType,
      task_role: side === "axis" && state?.scenario === "july" ? "exploit" : normalizeTaskRole("", fallbackType),
      operation_stage: side === "axis" && state?.scenario === "july" ? "exploit_frontier" : normalizeOperationStage("", "", fallbackType),
      title: "执行当前战略目标",
      priority: 1,
      depends_on: [],
      assigned_units: [...validUnits].filter((id) => RulesEngine.isCombatUnit({ id, ...state.units[id] })
        || RulesEngine.isSupplyUnit({ id, ...state.units[id] })),
      compatible_units: [],
      completion_condition: "当前战略目标取得可观察进展",
      failure_condition: "当前战略目标在现有局面下不可行",
      ...(goalCriteria ? { completion_criteria: goalCriteria } : {}),
      required_for_parent: false,
      source: "local_fallback"
    });
  }
  for (const base of skeleton.children) {
    let selectionKey = base.type === "breakthrough_step" ? base.id : base.type;
    if (base.observation_only) {
      while (selected.has(selectionKey)) selectionKey += "_local";
    }
    if (selected.has(selectionKey)) continue;
    const local = clone(base);
    if (local.observation_only) {
      const ids = new Set([...selected.values()].map((task) => task.id));
      while (ids.has(local.id)) local.id += "_local";
    }
    selected.set(selectionKey, local);
  }
  const normalizationCorrections = [];
  let normalizedChildren = modelDefined
    ? [...selected.values()]
    : skeleton.children
      .map((base) => selected.get(base.type === "breakthrough_step" ? base.id : base.type))
      .filter(Boolean);
  const childLimit = Math.max(1, Math.min(6, Number(maxChildTasks) || 6));
  const anchor = normalizedChildren.find((task) => task.type === "preserve_scoring_anchor");
  if (anchor && normalizedChildren.length > childLimit) {
    // Keep the local July invariant even when the model fills every task slot.
    while (normalizedChildren.length > childLimit) {
      const primaryPriority = Math.min(...normalizedChildren.filter((task) => task !== anchor).map((task) => task.priority));
      const removable = normalizedChildren.filter((task) => task !== anchor)
        .sort((left, right) => {
          const protectedRank = (task) => Number(task.task_class === "hard" || task.required_for_parent === true
            || task.priority === primaryPriority) * 2
            + Number(normalizedChildren.some((other) => other.depends_on?.includes(task.id)));
          return protectedRank(left) - protectedRank(right) || right.priority - left.priority;
        })[0];
      if (!removable) break;
      normalizedChildren = normalizedChildren.filter((task) => task !== removable);
      normalizationCorrections.push({
        correction: "preserved_local_scoring_anchor",
        removed_task_id: removable.id,
        removed_task: clone(removable),
        reason: "July Axis requires a terminal scoring-anchor invariant"
      });
    }
  }
  const children = normalizedChildren.slice(0, childLimit);
  for (const task of children) {
    task.task_class ||= normalizeTaskClass(task.task_class, task.type, { modelDefined });
    task.block_conditions = Array.isArray(task.block_conditions) && task.block_conditions.length
      ? task.block_conditions.slice(0, 6).map((condition) => safeText(condition, "", 180)).filter(Boolean)
      : defaultBlockConditions(task.model_task_type || task.type, side);
    task.progress_metric ||= defaultProgressMetric(task.type, task.model_task_type || "");
    task.progress_value = Number(task.progress_value || task.progress || 0);
    task.progress_evidence ||= "等待首次基于局面事实的进度评估";
  }
  const usedUnits = new Set();
  const combatOnlyTypes = new Set(["deny_scoring_frontier", "hold_blocking_line", "preserve_force", "disrupt_axis_supply", "counterattack", "joint_attack", "clear_blocker", "support", "protect_flank"]);
  const allocationGroups = {
    clear_blocker: (allocation?.spearhead || []).map((item) => typeof item === "string" ? item : item.unit),
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
  const combatTaskUnits = [...new Set([
    ...(allocationGroups.joint_attack || []),
    ...(allocationGroups.support || []),
    ...breakthroughUnits
  ])].filter((id) => validUnits.has(id));
  let breakthroughUnitsClaimed = false;
  for (const child of children) {
    child.compatible_units = ["joint_attack", "counterattack", "clear_blocker"].includes(child.type)
      ? [...new Set([
        ...(allocationGroups.joint_attack || []),
        ...(allocationGroups.support || []),
        ...(child.type === "clear_blocker" ? combatTaskUnits : [])
      ])]
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
    if (!modelDefined && !child.assigned_units.length && allocationGroups[child.type]) {
      child.assigned_units = allocationGroups[child.type].filter((id) => {
        if (!validUnits.has(id) || usedUnits.has(id)) return false;
        if (side === "allies" && combatOnlyTypes.has(child.type)
          && !RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) })) return false;
        usedUnits.add(id);
        return true;
      });
    }
    child.status = child.satisfied_at_plan_start
      ? "completed"
      : child.depends_on.length || (child.conditional_dependencies || []).some((dependency) => dependency.active)
        ? "pending" : "active";
    child.progress = child.satisfied_at_plan_start ? 1 : 0;
    child.last_blocked_reason = "";
    if (!child.assigned_units.length
      && !(["joint_attack", "clear_blocker"].includes(child.type) && child.compatible_units.length)
      && child.type !== "preserve_scoring_anchor"
      && (modelDefined || ["preserve_supply", "advance", "breakthrough_step", "support", "protect_flank", "joint_attack", "clear_blocker", "deny_scoring_frontier", "hold_blocking_line", "preserve_force", "disrupt_axis_supply", "counterattack"].includes(child.type))) {
      child.status = "blocked";
      child.last_blocked_reason = "no_units_assigned_after_normalization";
    }
  }
  const reserveTask = modelDefined ? null : children.find((child) => child.type === "reserve");
  if (reserveTask) {
    for (const id of validUnits) {
      if (usedUnits.has(id)) continue;
      reserveTask.assigned_units.push(id);
      usedUnits.add(id);
    }
  }
  const ids = new Set(children.map((child) => child.id));
  for (const child of children) {
    child.depends_on = [...new Set((child.depends_on || []).map(String))]
      .filter((id) => ids.has(id) && id !== child.id);
    child.soft_depends_on = [...new Set((child.soft_depends_on || []).map(String))]
      .filter((id) => ids.has(id) && id !== child.id && !child.depends_on.includes(id));
    child.conditional_dependencies = normalizeDependencyRefs(child.conditional_dependencies)
      .filter((dependency) => ids.has(dependency.id)
        && dependency.id !== child.id
        && !child.depends_on.includes(dependency.id));
    child.dependency_status = dependencyStatus(child, children);
  }
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
    ...(skeleton.parent.operation_family === "breakthrough_and_exploit" ? {
      // The local parent names the operation; the model still controls the
      // child tasks and may record a more specific operation title separately.
      title: skeleton.parent.title,
      model_title: safeText(rawParent.title, "", 140) || null,
      objective: skeleton.parent.objective,
      completion_condition: skeleton.parent.completion_condition,
      failure_condition: skeleton.parent.failure_condition,
      operation_family: "breakthrough_and_exploit",
      operation_stage: rawParent.operation_stage && OPERATION_STAGES.has(String(rawParent.operation_stage))
        ? String(rawParent.operation_stage) : "compress_defense",
      operation_stages: [...(skeleton.parent.operation_stages || [])]
    } : {
      title: safeText(rawParent.title, skeleton.parent.title, 140),
      objective: safeText(rawParent.objective, skeleton.parent.objective, 140),
      completion_condition: safeText(rawParent.completion_condition, skeleton.parent.completion_condition),
      failure_condition: safeText(rawParent.failure_condition, skeleton.parent.failure_condition)
    }),
    state: "active",
    started_turn: null,
    started_vp: null,
    source: rawChildren.length ? "model_plus_local_skeleton" : "local_skeleton"
  };
  const targetColumn = Number(skeleton.parent.target_column || 0);
  const denialTask = children.find((task) => task.type === "deny_scoring_frontier");
  if (denialTask && state?.scenario === "july" && Number.isFinite(targetColumn) && targetColumn > 0) {
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
    scenario: state?.scenario,
    goal_plan: skeleton.goal_plan || null,
    task_generation: modelDefined ? "model_defined" : "fixed_skeleton",
    normalized: true,
    normalization_corrections: normalizationCorrections
  };
}

function dependencyStatus(task, children) {
  const byId = new Map(children.map((item) => [item.id, item]));
  const hard = (task.depends_on || []).map((id) => ({ id, status: byId.get(id)?.status || "missing" }));
  const soft = (task.soft_depends_on || []).map((id) => ({ id, status: byId.get(id)?.status || "missing" }));
  const conditional = (task.conditional_dependencies || []).map((dependency) => ({
    ...dependency,
    status: byId.get(dependency.id)?.status || "missing"
  }));
  return {
    hard,
    soft,
    conditional,
    hard_ready: hard.every((dependency) => dependency.status === "completed"),
    conditional_ready: conditional.filter((dependency) => dependency.active)
      .every((dependency) => dependency.status === "completed")
  };
}

function taskDependenciesComplete(task, children) {
  const status = dependencyStatus(task, children);
  task.dependency_status = status;
  return status.hard_ready && status.conditional_ready;
}

function taskIdentity(task) {
  return task?.type === "model_task" ? task.id : task?.type === "breakthrough_step" ? task.id : task?.type;
}

function isTerminalTask(task) {
  return ["completed", "failed", "skipped"].includes(task?.status);
}

function taskMatchesPhase(task, phase, phaseKind) {
  const scopes = Array.isArray(task?.phase_scope) ? task.phase_scope.map((value) => String(value).toLowerCase()) : [];
  if (!scopes.length) return true;
  const current = String(phase || "").toLowerCase();
  const kind = String(phaseKind || "").toLowerCase();
  return scopes.some((scope) => scope === current
    || scope === kind
    || (scope === "movement" && kind !== "combat" && kind !== "supply_movement")
    || (scope === "supply" && kind === "supply_movement"));
}

function normalizeDependencyRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return { id: item, active: false, condition: "" };
    if (!item || typeof item !== "object") return null;
    return {
      id: String(item.id || item.task_id || item.depends_on || ""),
      active: item.active === true || item.condition_met === true || item.enabled === true,
      condition: safeText(item.condition || item.when || item.activation_condition, "", 180),
      hard: item.hard !== false && String(item.kind || item.dependency_type || "").toLowerCase() !== "soft"
    };
  }).filter((item) => item?.id);
}

function acceptedAttempt(stepRecord) {
  return [...(stepRecord?.action_attempts || [])].reverse().find((item) => item.accepted)
    || (stepRecord?.execution_ledger && stepRecord.action_applied?.applied && stepRecord.action_applied.result?.legal !== false
      ? { accepted: true, action: stepRecord.final_action, model_submitted: false } : null);
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
    const afterSupply = taskSupplyMap(ctx, defenderSide);
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

function cachedTaskVictory(ctx) {
  if (!ctx?.state || !ctx.rules || !ctx.terrain) return null;
  ctx.ai_victory_cache ||= RulesEngine.checkVictory(ctx);
  return ctx.ai_victory_cache;
}

function scenarioTaskScoring(input = {}) {
  const ctx = taskContext(input);
  const state = ctx?.state || {};
  if (!["september", "october"].includes(state.scenario)) return null;
  // These two scenario scores depend only on recorded unit outcomes. Use the
  // engine even when the post-action observer has no terrain context.
  const victory = RulesEngine.calculateVictoryPoints({ state });
  const item = (id) => victory.breakdown.find((entry) => entry.id === id);
  const supply = item("october_supply_exited_west");
  const combat = item("october_combat_exited_west");
  const mines = item("september_axis_cleared_mines");
  return {
    current_vp: victory.victory_points,
    supply_exit_ids: supply?.units || [],
    combat_exit_ids: combat?.units || [],
    withdrawal_vp: Number(supply?.points || 0) + Number(combat?.points || 0),
    cleared_mine_ids: mines?.mines || []
  };
}

function taskSupplyMap(ctx, side) {
  if (!ctx?.state || !side) return {};
  ctx.task_manager_supply_cache ||= {};
  if (!Object.hasOwn(ctx.task_manager_supply_cache, side)) {
    try { ctx.task_manager_supply_cache[side] = RulesEngine.checkSupply(ctx, side); }
    catch { ctx.task_manager_supply_cache[side] = {}; }
  }
  return ctx.task_manager_supply_cache[side];
}

function isFinalEvaluation(input = {}) {
  const state = input.state || input.ctx?.state || {};
  return input.status === "final_victory" || state.phase === "end_game_turn"
    && Number(state.turn || input.turn || 0) >= RulesEngine.scenarioFinalTurn(state.scenario);
}

function scoringFrontierForSide(input = {}, side) {
  const ctx = taskContext(input);
  if (!ctx?.state || ctx.state.scenario !== "july" || side !== "axis") return null;
  if (!ctx.rules || !ctx.terrain) return stateScoringFrontier(ctx.state, side);
  const victory = cachedTaskVictory(ctx);
  const advance = victory.breakdown?.find((item) => item.id === "july_east_of_3400");
  return Number(advance?.farthest_column || 34);
}

function alliedDefensePosture(plan, input = {}) {
  if (plan?.side !== "allies") return null;
  const ctx = taskContext(input);
  const state = ctx?.state || input.state || {};
  const scenarioScoring = scenarioTaskScoring(input);
  if (scenarioScoring) {
    return {
      protocol: "allied-scenario-denial-v1",
      current_axis_vp: scenarioScoring.current_vp,
      axis_withdrawal_vp: scenarioScoring.withdrawal_vp,
      axis_cleared_mines: scenarioScoring.cleared_mine_ids.length,
      exited_axis_units: scenarioScoring.supply_exit_ids.length + scenarioScoring.combat_exit_ids.length,
      next_threatened_column: null,
      defense_layers: [],
      campaign_status: state.scenario === "october" ? "deny_axis_west_edge_withdrawal" : "deny_axis_mine_clearance",
      priority: state.scenario === "october"
        ? "阻止 Axis 通过西侧撤出获得 VP，同时保持 Allied 防线、补给和战斗力。"
        : "保护 Allied 雷区并限制 Axis 清雷收益，同时维持补给和保存作战单位。"
    };
  }
  const frontier = scoringFrontierForSide({ ...input, ctx }, "axis");
  let currentVp = Number(state.victory_points ?? state.vp ?? 0);
  try {
    if (ctx?.rules && ctx?.terrain) currentVp = Number(cachedTaskVictory(ctx)?.victory_points || currentVp);
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
  const victory = cachedTaskVictory(ctx);
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
    // Combat-unit projections do not change the supply graph. Reuse the
    // network for every route preview in this context; supply-unit previews
    // remain uncached because their position is part of the graph.
    const reusable = !RulesEngine.isSupplyUnit({ id: unitId, ...unit });
    ctx.task_manager_projection_network_cache ||= {};
    const network = reusable
      ? (ctx.task_manager_projection_network_cache[unit.side]
        ||= RulesEngine.buildSupplyNetwork(ctx, unit.side))
      : RulesEngine.buildSupplyNetwork(ctx, unit.side);
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
  const requestedCheckpoint = Number(activeStep?.target_column || frontier.next_column);
  const minimumCheckpointColumn = Math.max(frontier.next_column,
    Number.isFinite(requestedCheckpoint) && requestedCheckpoint > 0 ? requestedCheckpoint : frontier.next_column);
  const requestedCampaignTarget = Number(plan?.parent?.target_column || minimumCheckpointColumn);
  const campaignTargetColumn = Math.max(minimumCheckpointColumn,
    Number.isFinite(requestedCampaignTarget) && requestedCampaignTarget > 0 ? requestedCampaignTarget : minimumCheckpointColumn);
  const checkpointColumns = (plan?.children || [])
    .filter((task) => task.type === "breakthrough_step" && !isTerminalTask(task))
    .map((task) => Number(task.target_column))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const units = Object.entries(ctx.state.units || {})
    .filter(([, unit]) => unit.side === side && !unit.eliminated && unit.hex && (unit.kind || "ground") === "ground")
    .map(([id, unit]) => ({ id, unit }))
    .filter(({ unit }) => RulesEngine.isCombatUnit({ ...unit }) || RulesEngine.isMapCounter({ ...unit }));
  const direct = [];
  const scoring = [];
  const approach = [];
  for (const { id, unit } of units) {
    let reachable;
    try { reachable = RulesEngine.reachableHexes(ctx, id, { mode: "normal", maxHexes: 120 }); }
    catch { continue; }
    const destinations = [...reachable.entries()]
      .filter(([hex, item]) => hex !== unit.hex && item?.path?.length > 1)
      .map(([hex, item]) => {
        const column = Number(String(hex).slice(0, 2));
        if (!Number.isFinite(column) || column <= frontier.current_column) return null;
        const zoc = [...RulesEngine.enemyZocSources(ctx, side, hex)];
        const mines = RulesEngine.enemyMinesAt(ctx, side, hex).map((mine) => mine.id);
        const risks = [
          ...(zoc.length ? [`enemy ZOC from ${zoc.join(", ")}`] : []),
          ...(mines.length ? [`enemy mines ${mines.join(", ")}`] : [])
        ];
        return {
          unit: id,
          from: unit.hex,
          destination: hex,
          path: item.path,
          target_column: column,
          crossed_checkpoints: checkpointColumns.filter((checkpoint) => checkpoint > frontier.current_column && checkpoint <= column),
          risks,
          score: Number((column * 100 - zoc.length * 12 - mines.length * 20 - item.path.length).toFixed(2))
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.target_column - left.target_column
        || left.risks.length - right.risks.length
        || left.path.length - right.path.length
        || right.score - left.score);
    if (!destinations.length) continue;
    let firstLegal = null;
    let best = null;
    for (const route of destinations) {
      let legal = false;
      try { legal = RulesEngine.checkMove(ctx, id, route.path, { mode: "normal" }).legal; }
      catch {}
      if (!legal) continue;
      const projectedSupply = projectedSupplyAt(ctx, id, route.destination);
      const scoringEligible = ["supplied", "partially_supplied", "partial"].includes(projectedSupply);
      const hydrated = {
        ...route,
        projected_supply: projectedSupply,
        scoring_eligible: scoringEligible,
        risks: [...(!scoringEligible ? [`projected supply ${projectedSupply}`] : []), ...route.risks],
        score: Number((route.score + (scoringEligible ? 10000 : 0)).toFixed(2))
      };
      firstLegal ||= hydrated;
      if (scoringEligible) {
        best = hydrated;
        break;
      }
    }
    best ||= firstLegal;
    if (!best) continue;
    if (best.scoring_eligible) scoring.push(best);
    if (best.target_column >= minimumCheckpointColumn) direct.push(best);
    else approach.push(best);
  }
  const routeOrder = (left, right) => Number(right.scoring_eligible) - Number(left.scoring_eligible)
    || right.target_column - left.target_column
    || left.risks.length - right.risks.length
    || left.path.length - right.path.length
    || right.score - left.score;
  direct.sort(routeOrder);
  scoring.sort(routeOrder);
  approach.sort(routeOrder);
  const directEligible = direct.filter((item) => item.scoring_eligible);
  const bestScoringRoutes = scoring.slice(0, 3);
  const reachesCurrentCheckpoint = bestScoringRoutes.some((route) => route.target_column >= minimumCheckpointColumn);
  const nextStep = reachesCurrentCheckpoint
    ? "direct_breakthrough"
    : direct.length
      ? "prepare_supply_or_reduce_risk"
      : bestScoringRoutes.length || approach.length
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
    protocol: "dynamic-frontier-breakthrough-v2-max-reach",
    current_column: frontier.current_column,
    target_column: minimumCheckpointColumn,
    minimum_checkpoint_column: minimumCheckpointColumn,
    campaign_target_column: campaignTargetColumn,
    vp_gain_at_target: frontier.vp_gain,
    scoring_requirement: frontier.scoring_requirement,
    next_step: nextStep,
    best_scoring_routes: bestScoringRoutes,
    direct_entry_routes: direct.slice(0, 3),
    scoring_eligible_direct_routes: directEligible.slice(0, 3),
    approach_routes: approach.slice(0, 3),
    recommended_unit_ids: [...new Set([...bestScoringRoutes, ...approach].slice(0, 3).map((item) => item.unit))],
    blocked_route_summary: bestScoringRoutes.length ? [] : direct.slice(0, 3).map((route) => ({
      unit: route.unit,
      destination: route.destination,
      projected_supply: route.projected_supply,
      risks: route.risks
    })),
    preparation_actions: preparation,
    model_freedom: "Choose the main axis, spearhead unit, and execution order from the verified routes or use tools to find another legal route. Intermediate columns are checkpoints, not mandatory stopping points."
  };
}

function taskMetrics(task, plan, input = {}) {
  const ctx = taskContext(input);
  const state = ctx?.state || input.state || {};
  const assigned = (task.assigned_units || []).filter((id) => state.units?.[id] && !state.units[id].eliminated);
  let supply = {};
  const observedSide = task.subject_side || plan.side;
  const enemySide = plan.side === "axis" ? "allies" : "axis";
  if (ctx?.rules && ctx?.terrain) supply = taskSupplyMap(ctx, plan.side);
  const supplyState = (id) => supply[id] || state.units?.[id]?.supply_state || state.units?.[id]?.supply || "unknown";
  const observedSupply = ctx?.rules && ctx?.terrain ? taskSupplyMap(ctx, observedSide) : {};
  const observedSupplyState = (id) => observedSupply[id] || state.units?.[id]?.supply_state || state.units?.[id]?.supply || "unknown";
  // July's only authoritative scoring frontier is the Axis frontier, even
  // when an Allied denial task is observing it.
  const julyFrontier = state.scenario === "july";
  const supplied = assigned.filter((id) => ["supplied", "partially_supplied"].includes(supplyState(id))).length;
  const columns = assigned.filter((id) => state.units[id].hex).map((id) => Number(String(state.units[id].hex).slice(0, 2))).filter(Number.isFinite);
  const scoringColumns = assigned
    .filter((id) => state.units[id].hex)
    .filter((id) => (state.units?.[id]?.kind || "ground") === "ground")
    .filter((id) => ["supplied", "partially_supplied"].includes(supplyState(id)))
    .map((id) => Number(String(state.units?.[id]?.hex || "").slice(0, 2)))
    .filter(Number.isFinite);
  const axisSupply = ctx?.rules && ctx?.terrain ? taskSupplyMap(ctx, "axis") : {};
  const axisSupplyState = (id) => axisSupply[id] || state.units?.[id]?.supply_state || state.units?.[id]?.supply || "unknown";
  const observedGlobalScoringColumns = Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === observedSide && !unit.eliminated && unit.hex && (unit.kind || "ground") === "ground")
    .filter(([id]) => ["supplied", "partially_supplied"].includes(observedSupplyState(id)))
    .map(([, unit]) => Number(String(unit.hex || "").slice(0, 2)))
    .filter(Number.isFinite);
  const axisGlobalScoringColumns = Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === "axis" && !unit.eliminated && unit.hex && (unit.kind || "ground") === "ground")
    .filter(([id]) => ["supplied", "partially_supplied"].includes(axisSupplyState(id)))
    .map(([, unit]) => Number(String(unit.hex || "").slice(0, 2)))
    .filter(Number.isFinite);
  const scoringEligibleCount = observedGlobalScoringColumns.length;
  const frontierColumn = axisGlobalScoringColumns.length ? Math.max(...axisGlobalScoringColumns) : null;
  const frontierEligibleCount = frontierColumn == null
    ? 0
    : axisGlobalScoringColumns.filter((column) => column === frontierColumn).length;
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
  const enemySupply = ctx?.rules && ctx?.terrain ? taskSupplyMap(ctx, enemySide) : {};
  const enemyCombat = Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === enemySide && !unit.eliminated && unit.hex && RulesEngine.isCombatUnit(unit));
  const enemySupplied = enemyCombat.filter(([id, unit]) =>
    ["supplied", "partially_supplied", "partial"].includes(enemySupply[id] || unit.supply_state || unit.supply)).length;
  const allUnits = Object.entries(state.units || {}).map(([id, unit]) => ({ id, ...unit }));
  const scenarioScoring = scenarioTaskScoring(input);
  const exitedIds = [...(scenarioScoring?.supply_exit_ids || []), ...(scenarioScoring?.combat_exit_ids || [])];
  const currentVictory = scenarioScoring ? { victory_points: scenarioScoring.current_vp } : cachedTaskVictory(ctx);
  const currentVp = Number(currentVictory?.victory_points ?? state.victory_points ?? state.vp ?? 0);
  const axisExitCandidates = allUnits.filter((unit) => unit.side === "axis" && !unit.eliminated && unit.hex
    && (RulesEngine.isCombatUnit(unit) || RulesEngine.isSupplyUnit(unit)));
  const nearestWestExitColumn = axisExitCandidates.length
    ? Math.min(...axisExitCandidates.map((unit) => Number(String(unit.hex).slice(0, 2))).filter(Number.isFinite))
    : null;
  const targetHex = task.target_hex || "";
  const targetDistances = targetHex
    ? assigned.map((id) => {
      try { return RulesEngine.hexDistance(state.units[id]?.hex, targetHex); }
      catch { return Infinity; }
    }).filter(Number.isFinite)
    : [];
  const zocRatio = assigned.length ? zocExposed / assigned.length : 0;
  return {
    assigned: assigned.length,
    assigned_unit_ids: [...(task.assigned_units || [])],
    assigned_west_columns: Object.fromEntries(assigned.filter((id) => state.units[id].hex)
      .map((id) => [id, Number(String(state.units[id].hex).slice(0, 2))])),
    assigned_exit_ids: exitedIds.filter((id) => (task.baseline_metrics?.assigned_unit_ids || task.assigned_units || []).includes(id)),
    supplied,
    farthest_column: columns.length ? Math.max(...columns) : null,
    farthest_scoring_column: julyFrontier && scoringColumns.length ? Math.max(...scoringColumns) : null,
    global_farthest_scoring_column: julyFrontier && axisGlobalScoringColumns.length ? Math.max(...axisGlobalScoringColumns) : null,
    scoring_eligible_count: scoringEligibleCount,
    frontier_eligible_count: julyFrontier ? frontierEligibleCount : 0,
    nearest_support_distance: supportDistances.length ? Math.min(...supportDistances) : null,
    zoc_exposed: zocExposed,
    zoc_exposed_ratio: Number(zocRatio.toFixed(2)),
    supplied_ratio: assigned.length ? Number((supplied / assigned.length).toFixed(2)) : 0,
    enemy_combat_count: enemyCombat.length,
    enemy_supplied_count: enemySupplied,
    enemy_supply_coverage: enemyCombat.length ? Number((enemySupplied / enemyCombat.length).toFixed(2)) : 0,
    current_vp: currentVp,
    axis_exited_west: exitedIds.length,
    axis_exited_supply_units: scenarioScoring?.supply_exit_ids.length || 0,
    axis_exited_combat_units: scenarioScoring?.combat_exit_ids.length || 0,
    axis_exit_vp: scenarioScoring?.withdrawal_vp || 0,
    assigned_exited_west: exitedIds.filter((id) => (task.baseline_metrics?.assigned_unit_ids || task.assigned_units || []).includes(id)).length,
    nearest_west_exit_column: nearestWestExitColumn,
    allied_mines_cleared_by_axis: scenarioScoring?.cleared_mine_ids.length || 0,
    cleared_mine_ids: scenarioScoring?.cleared_mine_ids || [],
    target_distance: targetDistances.length ? Math.min(...targetDistances) : null,
    target_column_reached: julyFrontier && task.target_column && scoringColumns.length
      ? Math.max(...scoringColumns) >= Number(task.target_column)
      : false
  };
}

function isWithdrawalTask(task, scenario, side) {
  return scenario === "october" && side === "axis"
    && ["withdraw", "withdrawal", "exit_west"].includes(task.model_task_type);
}

function withdrawalEvidence(task, current, baseline) {
  const ids = baseline.assigned_unit_ids || task.assigned_units || [];
  const exited = new Set(current.assigned_exit_ids || []);
  const preparation = ids.map((id) => {
    if (exited.has(id)) return 1;
    const before = baseline.assigned_west_columns?.[id];
    const after = current.assigned_west_columns?.[id];
    return before != null && after != null
      ? Math.min(0.8, Math.max(0, (before - after) / Math.max(1, before - 1)) * 0.8) : 0;
  });
  return {
    progress: ids.length ? preparation.reduce((sum, value) => sum + value, 0) / ids.length : 0,
    completed: ids.length > 0 && ids.every((id) => exited.has(id)),
    evidence: `west withdrawal ${exited.size}/${ids.length} assigned units exited legally; westward preparation is partial progress only, not VP or a verified complete route`
  };
}

function normalizeObservableCriteria(value) {
  if (!value || typeof value !== "object") return null;
  const source = Array.isArray(value) ? { all: value } : value;
  const normalize = (items) => (Array.isArray(items) ? items : [items]).filter(Boolean).map((item) => ({
    id: item.id || null,
    metric: safeText(item.metric || item.field, "", 80).toLowerCase(),
    relation: safeText(item.relation || item.operator, "at_least", 24).toLowerCase(),
    target: item.target ?? item.value ?? null,
    unit_ids: Array.isArray(item.unit_ids || item.units) ? (item.unit_ids || item.units).map(String).slice(0, 64) : [],
    beneficiary_unit_ids: Array.isArray(item.beneficiary_unit_ids || item.beneficiaries)
      ? (item.beneficiary_unit_ids || item.beneficiaries).map(String).slice(0, 64) : [],
    subject_side: item.subject_side || null,
    target_hex: item.target_hex || (typeof item.target === "string" && /^\d{4}$/.test(item.target) ? item.target : null),
    target_region: item.target_region || item.region || null,
    aggregation: item.aggregation || null,
    evaluation_scope: String(item.evaluation_scope || item.scope || "immediate").toLowerCase()
  }));
  const result = { all: normalize(source.all || []), any: normalize(source.any || []) };
  return result.all.length || result.any.length ? result : null;
}

function observableValue(criteria, task, current, input) {
  const state = input?.state || input?.ctx?.state || {};
  const subjectSide = criteria.subject_side || task.subject_side || input.side;
  const criterionUnits = Array.isArray(criteria.unit_ids) ? criteria.unit_ids : [];
  const beneficiaryUnits = Array.isArray(criteria.beneficiary_unit_ids) ? criteria.beneficiary_unit_ids : [];
  const values = {
    assigned_supply_ratio: current.supplied_ratio,
    supply_coverage: current.supplied_ratio,
    target_distance: current.target_distance,
    scoring_frontier: subjectSide === "axis"
      ? (current.global_farthest_scoring_column ?? scoringFrontierForSide(input, "axis"))
      : null,
    target_column: current.target_column_reached ? Number(task.target_column) : current.global_farthest_scoring_column,
    axis_vp: subjectSide === "axis" ? current.current_vp : null,
    axis_exit_vp: current.axis_exit_vp,
    axis_exited_units: current.axis_exited_west,
    axis_mines_cleared: current.allied_mines_cleared_by_axis,
    zoc_exposed: current.zoc_exposed,
    assigned_units_alive: current.assigned,
    unit_survival: current.assigned > 0 ? current.assigned / Math.max(1, (task.assigned_units || []).length) : 0,
    mine_clearance: current.allied_mines_cleared_by_axis,
    withdrawal_vp: current.axis_exit_vp,
    withdrawal_units: current.axis_exited_west,
    blocking_line: current.blocking_line_held,
    combat_opportunity: current.combat_opportunity_count
  };
  const unitIds = [...new Set(beneficiaryUnits.length ? beneficiaryUnits : criterionUnits.length ? criterionUnits : task.original_assigned_units || task.assigned_units || [])];
  if (unitIds.some((id) => state.units?.[id]?.side && state.units[id].side !== subjectSide)) return null;
  if (["unit_supply", "supply_coverage", "supplied_unit_count"].includes(criteria.metric) && unitIds.length) {
    const supply = input?.ctx?.rules && input?.ctx?.terrain ? taskSupplyMap(input.ctx, subjectSide) : {};
    const ids = [...new Set(unitIds)];
    if (ids.some((id) => !state.units?.[id])) return null;
    const count = ids.filter((id) => !state.units[id].eliminated
      && ["supplied", "partially_supplied", "partial"].includes(supply[id] || state.units[id].supply_state || state.units[id].supply)).length;
    return criteria.metric === "supplied_unit_count" ? count : count / ids.length;
  }
  if (["unit_survival", "survival", "surviving_unit_count"].includes(criteria.metric) && unitIds.length) {
    if (unitIds.some((id) => !state.units?.[id])) return null;
    const alive = unitIds.filter((id) => !state.units[id].eliminated).length;
    return criteria.metric === "surviving_unit_count" ? alive : alive / unitIds.length;
  }
  if (["at_target", "position", "units_at_target"].includes(criteria.metric) && unitIds.length) {
    if (unitIds.some((id) => !state.units?.[id])) return null;
    const region = criteria.target_region;
    if (criteria.target_hex && !RulesEngine.onMap(criteria.target_hex)) return null;
    if (!criteria.target_hex && !Array.isArray(region?.hexes) && !Number.isInteger(region?.column)) return null;
    const count = unitIds.filter((id) => {
      const unit = state.units[id];
      if (unit.eliminated || !unit.hex) return false;
      return criteria.target_hex ? unit.hex === RulesEngine.normalizeHex(criteria.target_hex)
        : Array.isArray(region?.hexes) ? region.hexes.includes(unit.hex) : Number(String(unit.hex).slice(0, 2)) === region.column;
    }).length;
    return criteria.metric === "units_at_target" ? count : count / unitIds.length;
  }
  if (criteria.metric === "target_distance" && criteria.target_hex && unitIds.length) {
    if (!RulesEngine.onMap(criteria.target_hex)) return null;
    const distances = unitIds.map((id) => state.units?.[id]?.hex
      ? RulesEngine.hexDistance(state.units[id].hex, criteria.target_hex) : null);
    return distances.some((distance) => distance == null) ? null : criteria.aggregation === "min" ? Math.min(...distances) : Math.max(...distances);
  }
  return values[criteria.metric] ?? null;
}

function compareObservable(value, relation, target) {
  if (value == null || target == null || value === "" || target === "") return null;
  if (typeof target === "boolean") return Boolean(value) === target;
  if (typeof target === "string" && !Number.isFinite(Number(target))) return String(value) === target;
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(target))) return null;
  const left = Number(value); const right = Number(target);
  if (relation === "at_most" || relation === "keep_below") return relation === "keep_below" ? left < right : left <= right;
  if (relation === "preserve") return left >= right;
  if (relation === "reduce") return left <= right;
  if (["equal", "equals", "eq"].includes(relation)) return left === right;
  if (["greater_than", "gt"].includes(relation)) return left > right;
  return relation === "at_least" ? left >= right : null;
}

function evaluateObservableCriteria(criteria, task, current, input) {
  if (!criteria) return null;
  const isCompletion = criteria === task.completion_criteria;
  criteria = normalizeObservableCriteria(criteria) || criteria;
  const { predicateErrors, acceptanceErrors } = require("./task_predicate_schema.js");
  const contractErrors = isCompletion ? acceptanceErrors(task, criteria) : [];
  const evaluate = (item) => {
    const errors = predicateErrors(item);
    const value = errors.length ? null : observableValue(item, task, current, input);
    const scopeReady = item.evaluation_scope === "immediate"
      || (item.evaluation_scope === "turn_end" && (input?.settlement?.kind === "turn_end" || isFinalEvaluation(input) || ["end_turn", "end_game_turn"].includes(String(input?.state?.phase || input?.phase || ""))))
      || (item.evaluation_scope === "game_end" && isFinalEvaluation(input));
    const comparison = compareObservable(value, item.relation, item.target);
    return { ...item, validation_errors: errors, value, comparison, met: comparison === true, status: comparison == null ? "unknown" : comparison ? "met" : "not_met", scope_ready: scopeReady,
      evidence_ref: `task:${task.id}:criterion:${item.metric}:${item.evaluation_scope}` };
  };
  const all = criteria.all.map(evaluate); const any = criteria.any.map(evaluate);
  const groupStatus = (items, mode) => {
    if (!items.length) return "met";
    if (mode === "all") {
      if (items.some((item) => item.status === "not_met")) return "not_met";
      return items.every((item) => item.status === "met") ? "met" : "unknown";
    }
    if (items.some((item) => item.status === "met")) return "met";
    return items.some((item) => item.status === "unknown") ? "unknown" : "not_met";
  };
  const allStatus = groupStatus(all, "all");
  const anyStatus = groupStatus(any, "any");
  const results = [...all, ...any];
  const validationErrors = [...contractErrors, ...results.flatMap((item) => item.validation_errors.map((error) => `${item.id || item.metric}:${error}`))];
  if (isCompletion && task.acceptance_contract?.mode === "maintain" && !contractErrors.length
    && (allStatus === "not_met" || anyStatus === "not_met")) {
    task.maintenance_breach ||= { turn: input.turn, step: input.step,
      evidence: results.filter((item) => item.status === "not_met") };
  }
  const maintenanceFailed = isCompletion && task.acceptance_contract?.mode === "maintain" && !!task.maintenance_breach;
  const met = !maintenanceFailed && !contractErrors.length && allStatus === "met" && anyStatus === "met";
  const conditionProgress = (item) => {
    if (item.value == null || item.target == null || item.value === "" || item.target === "") return null;
    if (item.comparison === true) return 1;
    const target = Number(item.target); const value = Number(item.value);
    if (!Number.isFinite(target) || !Number.isFinite(value)) return null;
    if (["at_most", "keep_below", "reduce"].includes(item.relation)) {
      return item.comparison === true ? 1 : Math.max(0, Math.min(0.99, target === 0 ? 0 : target / Math.max(Math.abs(value), Math.abs(target))));
    }
    return Math.max(0, Math.min(1, value / Math.max(1, target)));
  };
  const allProgress = all.map(conditionProgress);
  const anyProgress = any.map(conditionProgress);
  const groupProgress = (values, allRequired) => !values.length ? 1
    : !allRequired && values.includes(1) ? 1
      : values.some((value) => value == null) ? null : allRequired ? Math.min(...values) : Math.max(...values);
  const progress = [groupProgress(allProgress, true), groupProgress(anyProgress, false)];
  return {
    status: contractErrors.length ? "unknown" : maintenanceFailed ? "not_met" : met ? "met" : allStatus === "not_met" || anyStatus === "not_met" ? "not_met" : "unknown",
    maintenance_breach: maintenanceFailed ? clone(task.maintenance_breach) : null,
    validation_errors: validationErrors,
    scope_ready: all.every((item) => item.scope_ready)
      && (!any.length || any.some((item) => item.status === "met" && item.scope_ready)
        || any.every((item) => item.scope_ready)),
    progress: contractErrors.length || maintenanceFailed || progress.some((value) => value == null) ? 0 : Number(Math.min(...progress).toFixed(2)),
    progress_known: !contractErrors.length && progress.every((value) => value != null),
    conditions: results,
    evidence_refs: results.map((item) => item.evidence_ref),
    evidence: results.map((item) => `${item.metric}: ${item.value ?? "unknown"} ${item.relation} ${item.target}${item.scope_ready ? "" : " (scope pending)"}`).join("; ")
  };
}

function reconcileJulyScoringAnchor(task, current, input) {
  const state = input?.state || input?.ctx?.state || {};
  const frontier = scoringFrontierForSide(input, "axis");
  const previousTarget = task.target_column;
  const target = Math.max(35, Number(task.target_column || 35), frontier);
  task.target_column = target;
  task.completion_criteria.all[0].target = target;
  task.completion_condition = `终局时 Axis 有效计分前沿至少保持第 ${target} 列；单位和路线由模型选择`;
  task.failure_condition = `终局时 Axis 有效计分前沿低于第 ${target} 列`;
  const previous = task.scoring_anchor_state || "approaching";
  const final = isFinalEvaluation(input);
  const reached = Object.values(state.units || {}).some((unit) => unit.side === "axis" && !unit.eliminated
    && unit.hex && RulesEngine.isCombatUnit(unit) && Number(unit.hex.slice(0, 2)) >= target);
  const next = frontier >= target ? "secured" : task.scoring_anchor_ever_secured ? "lost" : reached ? "reached" : "approaching";
  if (next === "secured") task.scoring_anchor_ever_secured = true;
  task.scoring_anchor_state = next;
  task.scoring_anchor_history ||= [];
  if (next !== previous || target !== previousTarget) {
    if (next === "lost") task.scoring_anchor_loss_count = Number(task.scoring_anchor_loss_count || 0) + 1;
    task.scoring_anchor_history.push({ from: previous, to: next, frontier, previous_target: previousTarget, target,
      turn: input?.turn ?? state.turn ?? null, step: input?.step ?? null });
    task.scoring_anchor_history = task.scoring_anchor_history.slice(-32);
    task.scoring_anchor_transition = { from: previous, to: next, loss_count: task.scoring_anchor_loss_count || 0 };
  } else task.scoring_anchor_transition = null;
  task.progress = next === "secured" ? 1 : 0;
  task.progress_value = task.progress;
  task.progress_evidence = `Axis 有效计分前沿 ${frontier}；保持目标第 ${target} 列或更东；锚点状态 ${next}`;
  task.current_metrics = { ...current, global_farthest_scoring_column: frontier };
  task.completion_evidence = evaluateObservableCriteria(task.completion_criteria, task, task.current_metrics, input);
  task.next_action = next === "secured"
    ? "Compare preserving this supplied frontier, supporting it and further advance; choose the best final-VP tradeoff."
    : "Compare restoring scoring supply or frontier access with alternative VP gains; choose units and routes from current evidence.";
  if (final) {
    task.status = next === "secured" ? "completed" : "failed";
    task.terminal_reason = next === "secured" ? "scoring_anchor_held_at_final_evaluation" : "scoring_anchor_not_held_at_final_evaluation";
    if (task.status === "failed") task.failure_evidence = clone(task.completion_evidence);
  } else task.status = "active";
  return { progress: task.progress, completed: final && next === "secured", evidence: task.progress_evidence,
    anchor_state: next, frontier, target, transition: task.scoring_anchor_transition };
}

function modelTaskEvidence(task, current, baseline, input = {}, action = null, combatOutcome = null, impact = {}) {
  const kind = String(task.model_task_type || "custom").toLowerCase();
  const state = input?.state || input?.ctx?.state || {};
  const withdrawalTask = isWithdrawalTask(task, state.scenario, input.side || state.active_side);
  const columnDelta = Number(current.global_farthest_scoring_column || 0)
    - Number(baseline.global_farthest_scoring_column || 0);
  const supplyDelta = Number(current.supplied_ratio || 0) - Number(baseline.supplied_ratio || 0);
  const enemySupplyDelta = Number(current.enemy_supply_coverage || 0)
    - Number(baseline.enemy_supply_coverage || 0);
  const targetDistanceImproved = current.target_distance != null && baseline.target_distance != null
    && current.target_distance < baseline.target_distance;
  const combatSuccess = !!combatOutcome?.target_threat_reduced
    || Number(impact.axis_supply_coverage_delta || 0) < 0
    || Number(impact.axis_scoring_threat_delta || 0) < 0;
  const safeMove = action?.type === "move"
    && String(impact.force_preservation_risk || "none") === "none"
    && !(impact.enemy_zoc_sources || []).length;
  let progress = Number(task.progress || 0);
  let completed = false;
  let evidence = "";
  const explicit = evaluateObservableCriteria(task.completion_criteria, task, current, input);
  if (explicit) {
    progress = explicit.progress;
    completed = explicit.status === "met" && explicit.scope_ready;
    evidence = explicit.evidence;
    const failure = evaluateObservableCriteria(task.failure_criteria, task, current, input);
    const failed = !!failure && failure.status === "met" && failure.scope_ready;
    return { progress: Number(progress.toFixed(2)), completed: completed && !failed, failed, evidence,
      failure_evidence: failure?.evidence || "", status: failed ? "failed" : explicit.status };
  }
  if (["mine_clearance", "withdrawal_vp"].includes(task.metric)) {
    const matchingScenario = state.scenario === (task.metric === "mine_clearance" ? "september" : "october");
    const actual = task.metric === "mine_clearance" ? current.allied_mines_cleared_by_axis : current.axis_exit_vp;
    const target = task.target != null && task.target !== "" ? Number(task.target) : NaN;
    const defensive = ["at_most", "keep_below"].includes(task.relation);
    const scopeReady = (!defensive && task.evaluation_scope !== "game_end") || isFinalEvaluation(input);
    const met = matchingScenario && Number.isFinite(target)
      && (task.relation === "keep_below" ? actual < target : defensive ? actual <= target : actual >= target);
    progress = met ? 1 : 0;
    completed = scopeReady && met;
    if (defensive) task.defensive_status = completed ? "completed" : met ? "on_track" : "at_risk";
    if (isFinalEvaluation(input) && !completed) task.status = "failed";
    evidence = `rule-scored Axis ${task.metric}: ${actual}; ${task.relation || "at_least"} ${target}; scope ready: ${scopeReady}`;
  }
  else if (withdrawalTask) {
    ({ progress, completed, evidence } = withdrawalEvidence(task, current, baseline));
    if (isFinalEvaluation(input) && !completed) task.status = "failed";
  }
  else if (["clear_mine", "mine_clearance"].includes(kind)) {
    const newlyCleared = (current.cleared_mine_ids || []).filter((id) => !(baseline.cleared_mine_ids || []).includes(id));
    const relevant = task.target_hex
      ? newlyCleared.filter((id) => state.units?.[id]?.hex === task.target_hex)
      : newlyCleared;
    completed = relevant.length > 0;
    progress = completed ? 1 : 0;
    evidence = `new rule-scored mine clearances: ${relevant.join(", ") || "none"}`;
  }
  else if (task.type === "model_task") {
    const legacyEvidence = {
      supply: `assigned supply coverage ${current.supplied}/${current.assigned}`,
      screen: `${current.zoc_exposed}/${current.assigned} assigned units exposed to enemy ZOC`,
      defend: `${current.zoc_exposed}/${current.assigned} assigned units exposed to enemy ZOC`,
      protect: `${current.zoc_exposed}/${current.assigned} assigned units exposed to enemy ZOC`,
      hold_position: `${current.zoc_exposed}/${current.assigned} assigned units exposed to enemy ZOC`,
      recon: "reconnaissance has no state-changing completion evidence from the applied action"
    }[kind] || "model task has no machine-readable completion criteria; natural-language claims remain unverified";
    return {
      progress: Number(Number(task.progress || 0).toFixed(2)),
      completed: false,
      evidence: legacyEvidence,
      status: "unknown"
    };
  }
  else if (["advance", "exploit"].includes(kind)) {
    const target = Number(task.target_column || 0);
    const distanceProgress = target > 0 && baseline.global_farthest_scoring_column != null
      ? (Number(current.global_farthest_scoring_column || 0) - Number(baseline.global_farthest_scoring_column || 0))
        / Math.max(1, target - Number(baseline.global_farthest_scoring_column || 0))
      : 0;
    progress = Math.max(progress, Math.min(1, Math.max(distanceProgress, targetDistanceImproved ? 0.35 : 0)));
    completed = target > 0 ? current.target_column_reached : columnDelta > 0 && current.supplied_ratio >= 0.75;
    evidence = `frontier delta ${columnDelta}; target distance ${current.target_distance ?? "unknown"}; supplied ratio ${current.supplied_ratio}`;
  }
  else if (["supply"].includes(kind)) {
    progress = Math.max(progress, current.supplied_ratio);
    completed = current.assigned > 0 && current.supplied_ratio >= 1;
    evidence = `assigned supply coverage ${current.supplied}/${current.assigned}`;
  }
  else if (["screen", "defend", "protect", "hold_position"].includes(kind)) {
    progress = Math.max(progress, current.assigned ? 1 - current.zoc_exposed_ratio : 0);
    completed = current.assigned > 0 && baseline.zoc_exposed > 0 && current.zoc_exposed === 0;
    evidence = `${current.zoc_exposed}/${current.assigned} assigned units exposed to enemy ZOC`;
  }
  else if (["attack", "disrupt", "isolate", "clear_route"].includes(kind)) {
    progress = Math.max(progress, combatSuccess ? 0.7 : 0);
    completed = combatSuccess || enemySupplyDelta < 0;
    evidence = combatSuccess
      ? (combatOutcome?.evidence || []).join("; ") || "accepted action reduced the verified enemy threat"
      : `enemy supply coverage delta ${enemySupplyDelta}; no verified threat reduction`;
  }
  else if (["maneuver", "feint"].includes(kind)) {
    progress = current.target_distance != null && baseline.target_distance != null
      ? Math.max(0, Math.min(1, 1 - current.target_distance / Math.max(1, baseline.target_distance)))
      : progress;
    completed = task.target_hex ? current.target_distance === 0 : false;
    evidence = `target distance ${baseline.target_distance ?? "unknown"} -> ${current.target_distance ?? "unknown"}`;
  }
  else if (kind === "consolidate") {
    progress = Math.max(progress, safeMove && current.supplied_ratio >= baseline.supplied_ratio ? 0.5 : 0);
    completed = current.assigned > 0 && current.zoc_exposed === 0 && current.supplied_ratio >= 0.75
      && baseline.zoc_exposed > 0;
    evidence = `consolidation safety: zoc ${current.zoc_exposed}, supply ${current.supplied_ratio}`;
  }
  else if (kind === "recon") {
    evidence = "reconnaissance has no state-changing completion evidence from the applied action";
  }
  else {
    evidence = "custom task has no registered completion predicate; awaiting explicit observable evidence";
  }
  return { progress: Number(progress.toFixed(2)), completed, evidence };
}

function reconcileTaskState(plan, input) {
  const state = input?.state || input?.ctx?.state || {};
  const changes = [];
  for (const task of plan.children || []) {
    if (task.type === "preserve_scoring_anchor" && plan.side === "axis" && state.scenario === "july") {
      const current = taskMetrics(task, plan, input);
      const result = reconcileJulyScoringAnchor(task, current, input);
      changes.push({ task_id: task.id, status: task.status, progress: task.progress,
        evidence: result.evidence, anchor_state: result.anchor_state, transition: result.transition });
      continue;
    }
    if (isTerminalTask(task)) continue;
    if (task.type === "breakthrough_step" && task.status !== "active" && plan.side !== "axis") continue;
    const current = taskMetrics(task, plan, input);
    const baseline = task.baseline_metrics || current;
    task.baseline_metrics ||= baseline;
    task.current_metrics = current;
    const explicitEvidence = evaluateObservableCriteria(task.completion_criteria, task, current, input);
    const explicitFailure = evaluateObservableCriteria(task.failure_criteria, task, current, input);
    let progress = Number(task.progress || 0);
    let completed = false;
    let evidence = "";
    if (explicitEvidence) {
      progress = explicitEvidence.progress;
      completed = explicitEvidence.status === "met" && explicitEvidence.scope_ready;
      evidence = explicitEvidence.evidence;
      task.completion_evidence = {
        validation_errors: explicitEvidence.validation_errors,
        status: explicitEvidence.status,
        scope_ready: explicitEvidence.scope_ready,
        progress_known: explicitEvidence.progress_known,
        conditions: explicitEvidence.conditions,
        evidence_refs: explicitEvidence.evidence_refs
      };
      if (explicitFailure?.status === "met" && explicitFailure.scope_ready) {
        task.status = "failed";
        task.failure_evidence = explicitFailure.evidence;
        completed = false;
      }
    }
    else if (task.type === "deny_scoring_frontier" && ["september", "october"].includes(state.scenario)) {
      const target = Number(task.target ?? 0);
      const actual = state.scenario === "october" ? current.axis_exit_vp : current.allied_mines_cleared_by_axis;
      const final = isFinalEvaluation(input);
      const onTrack = task.relation === "keep_below" ? actual < target : actual <= target;
      progress = onTrack ? 1 : 0;
      completed = final && onTrack;
      task.defensive_status = completed ? "completed" : onTrack ? "on_track" : "at_risk";
      evidence = `Axis ${task.metric}: ${actual}; denial limit ${target}; evaluation ${final ? "game_end" : "in_progress"}`;
      if (final) task.status = onTrack ? "completed" : "failed";
      else if (!onTrack) task.status = "blocked";
    }
    else if (task.type === "deny_scoring_frontier") {
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
    else if (["preserve_force", "advance", "breakthrough_step"].includes(task.type) && state.scenario === "october" && plan.side === "axis") {
      ({ progress, completed, evidence } = withdrawalEvidence(task, current, baseline));
      if (isFinalEvaluation(input) && !completed && Number(state.turn || 1) > 10) task.status = "failed";
    }
    else if (["advance", "breakthrough_step"].includes(task.type) && state.scenario === "july" && (current.farthest_scoring_column ?? current.farthest_column ?? current.global_farthest_scoring_column) != null) {
      const currentColumn = current.farthest_scoring_column ?? current.farthest_column;
      const achievedColumn = current.global_farthest_scoring_column ?? currentColumn;
      const baselineColumn = baseline.farthest_scoring_column ?? baseline.farthest_column;
      const target = Number(task.target_column || plan.parent.target_column || baselineColumn + 1);
      task.target_column = target;
      const span = Math.max(1, target - Number(baselineColumn || target - 1));
      const measuredColumn = task.type === "breakthrough_step" && plan.side === "axis" ? achievedColumn : currentColumn;
      progress = Math.max(progress, Math.min(1, (Number(measuredColumn) - Number(baselineColumn || measuredColumn)) / span));
      completed = task.type === "breakthrough_step" && plan.side === "axis"
        ? Number(achievedColumn || 0) >= target && current.scoring_eligible_count > 0
        : Number(current.farthest_scoring_column || 0) >= target && current.supplied > 0;
      evidence = `assigned scoring frontier ${currentColumn}; global scoring frontier ${achievedColumn}; checkpoint ${target}; scoring-eligible units ${current.scoring_eligible_count}`;
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
      task.progress_value = 0;
      task.progress_evidence = "reserve actions do not complete the parent operation";
      continue;
    }
    else if (task.type === "model_task") {
      const modelEvidence = modelTaskEvidence(task, current, baseline, input);
      progress = modelEvidence.progress;
      completed = modelEvidence.completed;
      evidence = modelEvidence.evidence;
      if (modelEvidence.failed) {
        task.status = "failed";
        task.failure_evidence = modelEvidence.failure_evidence;
      }
    }
    task.progress = Number(Math.max(0, Math.min(1, progress)).toFixed(2));
    task.progress_value = task.progress;
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
  goal = { ...goal, target_column: goal.target_column ?? (goal.metric === "scoring_frontier" ? goal.target : null),
    target_vp: goal.target_vp ?? (goal.metric === "axis_vp" ? goal.target : null) };
  const scopeIsReady = !goal.evaluation_scope || goal.evaluation_scope === "immediate" || isFinalEvaluation(input)
    || goal.evaluation_scope === "turn_end" && (input.settlement?.kind === "turn_end" || input.state?.phase === "end_game_turn");
  const checks = [];
  const scenarioMetric = goal.metric === "mine_clearance" || goal.metric === "withdrawal_vp";
  if (scenarioMetric && goal.target != null && goal.target !== "" && Number.isFinite(Number(goal.target))) {
    const facts = scenarioTaskScoring(input);
    const state = input.state || input.ctx?.state || {};
    const expectedScenario = goal.metric === "mine_clearance" ? "september" : "october";
    const available = facts && state.scenario === expectedScenario && (goal.subject_side || "axis") === "axis";
    const actual = available ? (goal.metric === "mine_clearance" ? facts.cleared_mine_ids.length : facts.withdrawal_vp) : null;
    const defensive = ["at_most", "keep_below"].includes(goal.relation);
    const scopeReady = scopeIsReady;
    const target = Number(goal.target);
    checks.push({
      kind: goal.metric,
      subject_side: "axis",
      relation: goal.relation || "at_least",
      met: !!available && scopeReady && (goal.relation === "keep_below" ? actual < target : defensive ? actual <= target : actual >= target),
      actual,
      target,
      evaluation_scope: goal.evaluation_scope || "turn_end",
      scope_ready: scopeReady,
      source: "rules_engine_victory_breakdown"
    });
  }
  if (!scenarioMetric && goal.target_column != null && goal.target_column !== "" && Number.isInteger(Number(goal.target_column))) {
    const task = goal.relation === "keep_below"
      ? (plan.children || []).find((item) => item.type === "deny_scoring_frontier")
      : (plan.children || [])
        .filter((item) => item.type === "breakthrough_step" || item.type === "advance")
        .sort((left, right) => {
          const target = Number(goal.target_column);
          const leftExact = Number(left.target_column) === target ? 0 : 1;
          const rightExact = Number(right.target_column) === target ? 0 : 1;
          return leftExact - rightExact
            || Number(right.target_column || 0) - Number(left.target_column || 0);
        })[0];
    const subject = goal.subject_side || plan.side;
    const column = Number(task?.current_metrics?.global_farthest_scoring_column ?? scoringFrontierForSide(input, subject));
    const defensive = ["keep_below", "at_most"].includes(goal.relation);
    const scopeReady = scopeIsReady;
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
    let vp = Number(scenarioTaskScoring(input)?.current_vp ?? input?.state?.victory_points ?? 0);
    try { if (ctx?.rules && ctx?.terrain) vp = Number(cachedTaskVictory(ctx)?.victory_points || 0); }
    catch {}
    const atMost = ["at_most", "keep_below"].includes(goal.relation);
    const scopeReady = scopeIsReady;
    checks.push({ kind: "victory_points", relation: goal.relation || "at_least", met: scopeReady && (goal.relation === "keep_below" ? vp < Number(goal.target_vp) : atMost ? vp <= Number(goal.target_vp) : vp >= Number(goal.target_vp)), actual: vp, target: Number(goal.target_vp), scope_ready: scopeReady });
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
  const campaign = groundedGoalCompleted(plan, input, plan.goal_plan?.campaign_goal);
  const campaignRequired = campaign.evidence.length > 0;
  if (plan.side !== "allies") {
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
  const axisSupply = taskSupplyMap(ctx, "axis");
  const axisFrontier = scoringFrontierForSide({ ...input, ctx }, "axis");
  const scenario = state.scenario || "july";
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
          return ["supplied", "partially_supplied", "partial"].includes(axisSupply[id])
            && (scenario !== "july" || (axisFrontier != null && column >= axisFrontier - 1));
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
        && (scenario !== "july" || (axisFrontier != null && Number(String(unit.hex).slice(0, 2)) >= axisFrontier - 1)))
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

function axisCombatPreparation(plan, input = {}) {
  const ctx = taskContext(input);
  const phaseKind = RulesEngine.phaseKind(input.phase || ctx?.state?.phase || "");
  if (plan?.side !== "axis" || !ctx?.state || !["initial_movement", "mechanized_movement"].includes(phaseKind)) {
    return { targets: [], preparation_actions: [], recommended_unit_ids: [] };
  }
  const state = ctx.state;
  const eligible = [...phaseEligibleSet({ ...input, ctx })]
    .filter((id) => RulesEngine.isCombatUnit({ id, ...(state.units?.[id] || {}) }));
  const performance = input.performance || {};
  const maxPreparationUnits = Math.max(1, Number(performance.max_preparation_units || 12));
  const maxPreparationTargets = Math.max(1, Number(performance.max_preparation_targets || 12));
  const maxReachableHexes = Math.max(12, Number(performance.max_preparation_reachable_hexes || 60));
  ctx.task_manager_axis_preparation_cache ||= new Map();
  const preparationCacheKey = [
    phaseKind,
    input.side || state.active_side,
    maxPreparationUnits,
    maxPreparationTargets,
    maxReachableHexes
  ].join(":");
  if (ctx.task_manager_axis_preparation_cache.has(preparationCacheKey)) {
    return clone(ctx.task_manager_axis_preparation_cache.get(preparationCacheKey));
  }
  const scannedEligible = eligible.slice(0, maxPreparationUnits);
  const enemies = Object.entries(state.units || {})
    .filter(([, unit]) => unit.side === "allies" && unit.hex && !unit.eliminated && RulesEngine.isCombatUnit(unit));
  // Reachability is independent of the enemy target. Cache it once per unit
  // and calculate it only after the existing distance filter needs it.
  const reachableByUnit = new Map();
  const reachableFor = (id) => {
    if (reachableByUnit.has(id)) return reachableByUnit.get(id);
    try {
      reachableByUnit.set(id, RulesEngine.reachableHexes(ctx, id, { mode: "normal", maxHexes: maxReachableHexes }));
    }
    catch {
      reachableByUnit.set(id, new Map());
    }
    return reachableByUnit.get(id);
  };
  const targets = [];
  for (const [enemyId, enemy] of enemies.slice(0, maxPreparationTargets)) {
    const approaches = [];
    for (const id of scannedEligible) {
      const unit = state.units[id];
      if (!unit?.hex) continue;
      const distance = RulesEngine.hexDistance(unit.hex, enemy.hex);
      if (distance === 1) {
        approaches.push({ unit: id, from: unit.hex, status: "already_adjacent", distance: 1 });
        continue;
      }
      if (distance > Number(unit.movement || 0) + 1) continue;
      const reachable = reachableFor(id);
      const destinations = [...reachable.entries()]
        .filter(([hex, item]) => hex !== unit.hex && item?.path?.length > 1
          && RulesEngine.neighbors(hex).includes(enemy.hex))
        .map(([hex, item]) => {
          const projectedSupply = projectedSupplyAt(ctx, id, hex);
          return {
            unit: id,
            from: unit.hex,
            destination: hex,
            distance: item.cost ?? item.path.length - 1,
            projected_supply: projectedSupply,
            supply_risk: ["supplied", "partially_supplied", "partial"].includes(projectedSupply) ? "none" : projectedSupply
          };
        })
        .filter(Boolean)
        .sort((left, right) => (left.supply_risk === "none" ? -1 : 1) - (right.supply_risk === "none" ? -1 : 1)
          || left.distance - right.distance)
        .slice(0, 1);
      if (destinations.length) approaches.push({ ...destinations[0], status: "can_approach", distance });
    }
    if (!approaches.length) continue;
    const currentAttackers = approaches.filter((item) => item.status === "already_adjacent").map((item) => item.unit);
    const approachingUnits = approaches.filter((item) => item.status === "can_approach").map((item) => item.unit);
    targets.push({
      target_hex: enemy.hex,
      defender_ids: [enemyId],
      current_attackers: currentAttackers,
      approaching_units: approachingUnits,
      approaches,
      joint_attack_potential: currentAttackers.length + approachingUnits.length >= 2,
      verified_combat: false,
      reason: "movement-phase preparation only; final positions, defender hexes, odds, and legality must be rechecked in combat phase"
    });
  }
  targets.sort((left, right) => Number(right.joint_attack_potential) - Number(left.joint_attack_potential)
    || right.approaches.length - left.approaches.length);
  const limited = targets.slice(0, 6);
  const result = {
    targets: limited,
    recommended_unit_ids: [...new Set(limited.flatMap((item) => item.approaches.map((approach) => approach.unit)))].slice(0, 12),
    scanned_unit_count: scannedEligible.length,
    skipped_unit_count: Math.max(0, eligible.length - scannedEligible.length),
    scanned_target_count: Math.min(enemies.length, maxPreparationTargets),
    skipped_target_count: Math.max(0, enemies.length - maxPreparationTargets),
    limits: {
      max_preparation_units: maxPreparationUnits,
      max_preparation_targets: maxPreparationTargets,
      max_preparation_reachable_hexes: maxReachableHexes
    },
    preparation_actions: limited.length
      ? [
        "优先把能形成同一目标联合攻击的部分单位移动到目标相邻位置",
        "移动前检查 projected_supply，避免为了接触敌人而切断突破补给",
        "进入 combat phase 后重新读取 phase_status，并用 check_combat 验证实际攻击者子集和全部防守格",
        "如果没有达到 2-1 的组合，保留兵力并为下一回合集结，不要重复同一低赔率攻击"
      ]
      : [
        "当前没有能在本阶段接近敌方作战单位的合法路线，继续推进计分前沿或改善补给",
        "下一战斗阶段仍需用 phase_status 检查新形成的接触"
      ]
  };
  ctx.task_manager_axis_preparation_cache.set(preparationCacheKey, result);
  return clone(result);
}

function axisTacticalOpportunities(plan, input = {}) {
  const ctx = taskContext(input);
  if (plan?.side !== "axis" || !ctx?.state || RulesEngine.phaseKind(input.phase || ctx.state.phase || "") !== "combat") {
    return { clear_blocker: [], joint_attack: [] };
  }
  const state = ctx.state;
  const eligible = phaseEligibleSet({ ...input, ctx });
  const byHex = RulesEngine.unitsByHex(ctx);
  const scenario = state.scenario || "july";
  const frontier = scoringFrontierForSide({ ...input, ctx }, "axis");
  const targetHexes = [...new Set([...eligible].flatMap((id) => {
    const unit = state.units?.[id];
    return unit?.hex ? RulesEngine.neighbors(unit.hex).filter((hex) => (byHex[hex] || []).some((enemy) =>
      enemy.side === "allies" && !enemy.eliminated && RulesEngine.isCombatUnit(enemy))) : [];
  }))];
  const opportunities = [];
  for (const targetHex of targetHexes) {
    const attackers = [...eligible].filter((id) => {
      const unit = state.units?.[id];
      return unit?.hex && RulesEngine.neighbors(unit.hex).includes(targetHex);
    });
    const defenderHexesFor = (ids) => [...new Set([targetHex, ...ids.flatMap((id) => {
      const unit = state.units?.[id];
      return RulesEngine.neighbors(unit.hex).filter((hex) => (byHex[hex] || []).some((enemy) =>
        enemy.side === "allies" && !enemy.eliminated && RulesEngine.isCombatUnit(enemy)));
    })])].sort();
    const ranked = attackers.slice().sort((left, right) => {
      const leftUnit = state.units[left];
      const rightUnit = state.units[right];
      let leftAttack = Number(leftUnit?.attack || 0);
      let rightAttack = Number(rightUnit?.attack || 0);
      try { leftAttack = Number(RulesEngine.effectiveAttack(ctx, { id: left, ...leftUnit }) || leftAttack); } catch {}
      try { rightAttack = Number(RulesEngine.effectiveAttack(ctx, { id: right, ...rightUnit }) || rightAttack); } catch {}
      return rightAttack - leftAttack || left.localeCompare(right);
    });
    let best = null;
    for (let count = 1; count <= ranked.length; count += 1) {
      const selected = ranked.slice(0, count);
      let verdict;
      try {
        verdict = RulesEngine.checkCombat(ctx, {
          attackers: selected,
          defender_hexes: defenderHexesFor(selected)
        });
      }
      catch { verdict = { legal: false }; }
      const ratio = oddsRatio(verdict.details?.odds_column);
      if (verdict.legal && ratio != null && ratio >= 2) {
        best = {
          attackers: selected,
          defender_hexes: verdict.details?.defender_hexes || defenderHexesFor(selected),
          odds_column: verdict.details?.odds_column || "",
          target_hex: targetHex,
          target_column: Number(String(targetHex).slice(0, 2)),
          blocks_frontier: scenario === "july" && frontier != null
            ? Number(String(targetHex).slice(0, 2)) >= frontier - 1
            : false,
          blocks_withdrawal_route: scenario === "october" && Number(String(targetHex).slice(0, 2)) <= 12,
          reason: "locally verified Axis attack at or above 2-1; model may choose any valid subset and must recheck it"
        };
        break;
      }
    }
    if (best) opportunities.push(best);
  }
  opportunities.sort((left, right) => (Number(right.blocks_frontier) + Number(right.blocks_withdrawal_route))
    - (Number(left.blocks_frontier) + Number(left.blocks_withdrawal_route))
    || Number(right.target_column) - Number(left.target_column)
    || right.attackers.length - left.attackers.length);
  const limited = opportunities.slice(0, 4);
  return { clear_blocker: limited, joint_attack: limited.filter((item) => item.attackers.length > 1) };
}

function ensureAxisTacticalTasks(plan, opportunities) {
  if (plan?.side !== "axis") return;
  const clear = opportunities?.clear_blocker || [];
  const joint = opportunities?.joint_attack || [];
  if (!clear.length && !joint.length) return;
  let clearTask = (plan.children || []).find((task) => task.type === "clear_blocker");
  if (!clearTask) {
    const reserve = (plan.children || []).find((task) => task.type === "reserve");
    if (reserve) {
      reserve.status = "skipped";
      reserve.skip_reason = "replaced by a verified combat opportunity for this phase";
    }
    clearTask = {
      id: "clear_blocker",
      type: "clear_blocker",
      title: "清除突破路线上的关键阻挡",
      priority: 10,
      depends_on: [],
      assigned_units: [],
      compatible_units: [],
      progress: 0,
      status: "active",
      next_action: "使用 phase_status 查看目标和推荐攻击组合，再用 check_combat 与 act 复核",
      completion_condition: "通过规则验证的战斗或清雷行动降低突破路线阻挡",
      failure_condition: "当前路线阻挡无法在可接受风险下清除",
      source: "local_tactical_opportunity"
    };
    const reserveIndex = plan.children.findIndex((task) => task.type === "reserve");
    if (reserveIndex >= 0) plan.children.splice(reserveIndex, 1, clearTask);
    else plan.children.push(clearTask);
  }
  clearTask.status = "active";
  clearTask.tactical_opportunities = clear;
  clearTask.compatible_units = [...new Set(clear.flatMap((item) => item.attackers))];
  plan.tactical_opportunities = { ...(plan.tactical_opportunities || {}), clear_blocker: clear, joint_attack: joint };
  clearTask.activation_reason = `local_rules_found_${clear.length}_clear_blocker_opportunity`;
  clearTask.next_action = "从规则验证的机会中选择一个目标和任意合适的攻击者子集，先 check_combat，再 act";
}

function activateTasks(plan, maxActive = 3, input = null) {
  const children = plan.children || [];
  const modelDefinedTasks = plan?.task_generation === "model_defined"
    || plan?.protocol === "model-defined-task-v1";
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
      .filter((task) => !isTerminalTask(task) && !task.execution_blocked && taskDependenciesComplete(task, children))
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
  if (plan.side === "axis" && input) {
    const opportunities = axisTacticalOpportunities(plan, input);
    if (!modelDefinedTasks) ensureAxisTacticalTasks(plan, opportunities);
    const preparation = axisCombatPreparation(plan, input);
    const breakthrough = modelDefinedTasks ? null : plan.children.find((task) =>
      task.type === "breakthrough_step" && task.status === "active"
    );
    if (breakthrough) {
      breakthrough.combat_preparation = preparation.targets;
      breakthrough.preparation_actions = preparation.preparation_actions;
    }
    plan.tactical_opportunities = {
      ...(plan.tactical_opportunities || {}),
      ...opportunities,
      preparation: preparation.targets,
      preparation_actions: preparation.preparation_actions,
      recommended_preparation_unit_ids: preparation.recommended_unit_ids
    };
  }
  const active = children.filter((task) => task.status === "active" && !task.observation_only)
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
    .filter((task) => task.status === "active"
      && (allowedTypes.has(task.type) || task.type === "model_task")
      && taskMatchesPhase(task, phase, phaseKind))
    .map((task) => ({
      task,
      eligible_units: [...new Set([
        ...(task.assigned_units || []),
        ...(task.compatible_units || [])
      ])].filter((id) => eligible.has(id))
    }))
    .filter((item) => item.eligible_units.length)
    .sort((left, right) => {
      const tacticalRank = (task) => phaseKind === "combat" && side === "axis"
        ? (["clear_blocker", "joint_attack"].includes(task.type) ? 0 : 1)
        : 0;
      return tacticalRank(left.task) - tacticalRank(right.task)
      || left.task.priority - right.task.priority
      || (left.task.status === "active" ? 0 : 1) - (right.task.status === "active" ? 0 : 1)
      || left.task.id.localeCompare(right.task.id);
    });
  const primary = candidates[0] || null;
  const modelDefinedTasks = plan?.task_generation === "model_defined"
    || plan?.protocol === "model-defined-task-v1";
  const frontierBreakthrough = side === "axis" && !modelDefinedTasks ? frontierBreakthroughPlan(plan, input) : null;
  const dynamicRouteUnits = !modelDefinedTasks && ["initial_movement", "mechanized_movement"].includes(phaseKind)
    ? (frontierBreakthrough?.recommended_unit_ids || []).filter((id) => eligible.has(id))
    : [];
  const primaryUnits = primary?.eligible_units || [];
  const dynamicallyReassigned = dynamicRouteUnits.filter((id) => !primaryUnits.includes(id));
  const combatPreparation = side === "axis"
    ? axisCombatPreparation(plan, { ...input, ctx: context })
    : { targets: [], preparation_actions: [], recommended_unit_ids: [] };
  const dispatchTask = ({ task, eligible_units }) => ({
    id: task.id,
    type: task.type,
    model_task_type: task.model_task_type,
    task_role: task.task_role || "",
    operation_stage: task.operation_stage || "",
    title: task.title,
    status: task.status,
    priority: task.priority,
    assigned_units: task.assigned_units || [],
    eligible_units,
    eligible_unit_count: eligible_units.length,
    can_execute: eligible_units.length > 0,
    blocked_reason: eligible_units.length ? "" : task.last_blocked_reason || "no_eligible_unit_in_current_phase",
    dependency_status: task.dependency_status || dependencyStatus(task, plan.children || []),
    tactical_opportunities: task.tactical_opportunities || [],
    activation_reason: task.activation_reason || "",
    next_action: task.next_action,
    completion_condition: task.completion_condition,
    target_column: task.target_column ?? null,
    target_column_source: task.target_column_source || "none",
    target_selection_policy: task.target_selection_policy || "scenario_specific"
  });
  const blockedTasks = (plan?.children || [])
    .filter((task) => !isTerminalTask(task) && !task.observation_only && !candidates.some((candidate) => candidate.task.id === task.id))
    .map((task) => dispatchTask({ task, eligible_units: [] }));
  return {
    phase_kind: phaseKind,
    rule: "Prefer the highest-priority task that has eligible units in the current phase; keep units assigned to other tasks in reserve unless no current task can act.",
    tasks: candidates.map(dispatchTask),
    blocked_tasks: blockedTasks,
    primary_task_id: primary?.task.id || "",
    operation: plan?.parent?.operation_family ? {
      family: plan.parent.operation_family,
      stage: plan.parent.operation_stage || "",
      stages: plan.parent.operation_stages || [],
      operational_target_column: plan.parent.operational_target_column ?? null,
      target_selection: plan.parent.operation_family === "breakthrough_and_exploit"
        ? "model_selected_after_breakthrough" : "scenario_specific"
    } : null,
    preferred_units: [...new Set([...dynamicRouteUnits, ...primaryUnits])],
    allowed_unit_ids: [...new Set([...candidates.flatMap((item) => item.eligible_units), ...dynamicRouteUnits])],
    eligible_units_at_phase_start: [...eligible],
    defensive_posture: side === "allies" ? clone(plan?.defensive_posture || alliedDefensePosture(plan, input)) : null,
    frontier_breakthrough: frontierBreakthrough,
    upcoming_combat_opportunities: combatPreparation.targets,
    preparation_actions: combatPreparation.preparation_actions,
    recommended_preparation_unit_ids: combatPreparation.recommended_unit_ids,
    ...(side === "axis" ? {
      dynamic_spearhead_unit_ids: dynamicRouteUnits,
      dynamic_spearhead_reassignment: dynamicallyReassigned.length > 0,
      execution_source: dynamicallyReassigned.length > 0 ? "dynamic_spearhead_reassignment" : "task_assignment"
    } : {})
  };
}

function taskActionFeedback(plan, input, stepRecord, task = null, progress = null, evidence = "") {
  const accepted = acceptedAttempt(stepRecord);
  const evaluation = accepted?.assessment?.evaluation || {};
  const impact = evaluation.victory_impact || {};
  const action = stepRecord?.final_action || stepRecord?.action || {};
  const unitIds = [...new Set(action.unit ? [action.unit] : (action.attackers || []))];
  const state = input?.state || {};
  const appliedResult = stepRecord?.action_applied?.result || null;
  const units = Object.fromEntries(unitIds.map((id) => {
    const unit = state.units?.[id];
    return [id, unit ? {
      hex: unit.hex || "",
      supply: impact.projected_supply_after_move || unit.supply_state || unit.supply || "unknown",
      enemy_zoc: (evaluation.enemy_zoc_sources || []).length > 0,
      eliminated: !!unit.eliminated
    } : { missing: true }];
  }));
  return {
    accepted: !!accepted || stepRecord?.final_action_source === "local_fallback",
    action_type: action.type || "",
    unit_ids: unitIds,
    units,
    self_vp_delta: stepRecord?.action_effect?.actual_vp_delta == null ? null : Number(stepRecord.action_effect.actual_vp_delta),
    projected_self_vp_delta: impact.projected_vp_delta_from_current_state == null
      && impact.estimated_vp_delta == null ? null
      : Number(impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta),
    opponent_vp_delta: Number(impact.opponent_vp_delta || 0),
    axis_scoring_threat_delta: Number(impact.axis_scoring_threat_delta || 0),
    supply_risk_delta: Number(impact.supply_risk_delta || 0),
    force_preservation_risk: impact.force_preservation_risk || "none",
    projected_supply_after_action: impact.projected_supply_after_move || null,
    enemy_zoc_sources: evaluation.enemy_zoc_sources || [],
    task_id: task?.id || "",
    task_type: task?.model_task_type || task?.type || "",
    task_progress: progress,
    task_evidence: evidence,
    applied_result: appliedResult ? {
      legal: appliedResult.legal,
      outcome: appliedResult.outcome || "",
      details: appliedResult.details ? {
        outcome: appliedResult.details.outcome || "",
        eliminated: (appliedResult.details.effects?.eliminated || []).slice(0, 12),
        retreated: (appliedResult.details.effects?.retreated?.retreated || []).slice(0, 12)
      } : null
    } : null
  };
}

function localTaskProgress(plan, input, stepRecord) {
  const state = input?.state || input?.ctx?.state || {};
  const action = stepRecord?.final_action || stepRecord?.action || {};
  const acceptedRecord = acceptedAttempt(stepRecord);
  const accepted = !!acceptedRecord || stepRecord?.final_action_source === "local_fallback";
  const explicitTasks = (plan.children || []).filter((task) => !isTerminalTask(task) && !task.observation_only && task.completion_criteria);
  if (explicitTasks.length && (accepted || stepRecord?.action_applied?.applied)) {
    const changes = [];
    for (const task of explicitTasks) {
      const current = taskMetrics(task, plan, input);
      const result = evaluateObservableCriteria(task.completion_criteria, task, current, input);
      const failure = evaluateObservableCriteria(task.failure_criteria, task, current, input);
      if (!result) continue;
      const before = { progress: Number(task.progress || 0), status: task.status };
      task.current_metrics = current;
      task.completion_evidence = result;
      task.progress = result.progress_known ? result.progress : before.progress;
      task.progress_value = task.progress;
      task.progress_evidence = result.evidence;
      if (failure?.status === "met" && failure.scope_ready) {
        task.status = "failed";
        task.failure_evidence = failure;
      } else if (result.status === "met" && result.scope_ready) task.status = "completed";
      if (task.progress !== before.progress || task.status !== before.status) changes.push({ task_id: task.id,
        task_type: task.type, progress: task.progress, delta: task.progress - before.progress,
        status_before: before.status, status_after: task.status, evidence: result.evidence, condition_evidence: result });
    }
    if (changes.length) {
      activateTasks(plan, 3, input);
      return { ...changes[0], changed: changes.some((item) => item.delta > 0 || item.status_after === "completed"),
        changes, parent_completed: updateParentState(plan), execution_source: "observable_conditions" };
    }
    const ids = new Set(action.unit ? [action.unit] : action.attackers || []);
    if (explicitTasks.some((task) => task.assigned_units?.some((id) => ids.has(id)))) {
      return { changed: false, reason: "observable_conditions_unchanged", task_id: explicitTasks.find((task) =>
        task.assigned_units?.some((id) => ids.has(id)))?.id };
    }
  }
  if (!accepted || action.type === "pass") return { changed: false, reason: "no_accepted_non_pass_action" };
  const unitIds = new Set(action.unit ? [action.unit] : (action.attackers || []));
  const combatPriority = new Map(["clear_blocker", "joint_attack", "counterattack"].map((type, index) => [type, index]));
  const matching = (plan.children || [])
    .filter((task) => !isTerminalTask(task)
      && (task.assigned_units || []).concat(action.type === "combat" ? task.compatible_units || [] : [])
        .some((id) => unitIds.has(id)))
    .sort((left, right) => (action.type === "combat"
      ? (combatPriority.get(left.type) ?? 10) - (combatPriority.get(right.type) ?? 10)
      : 0)
      || (left.status === "active" ? -1 : 1) - (right.status === "active" ? -1 : 1)
      || left.priority - right.priority
      || left.id.localeCompare(right.id));
  const appliedDetails = stepRecord?.action_applied?.result?.details || {};
  const mineCleared = appliedDetails.cleared === true
    || (Array.isArray(stepRecord?.action_applied?.result?.mine_clearance?.removed)
      && stepRecord.action_applied.result.mine_clearance.removed.length > 0);
  if (mineCleared) {
    const mineTasks = (plan.children || []).filter((candidate) => !isTerminalTask(candidate)
      && (["mine_clearance", "clear_blocker"].includes(candidate.type)
        || ["mine_clearance", "clear_mine"].includes(candidate.model_task_type)));
    for (const mineTask of mineTasks.sort((left, right) => left.priority - right.priority)) {
      if (!matching.includes(mineTask)) matching.unshift(mineTask);
    }
  }
  let dynamicSpearheadReassignment = false;
  if (plan.side === "axis" && action.type === "move") {
    const dynamicBreakthrough = (plan.children || [])
      .filter((task) => task.type === "breakthrough_step" && task.status === "active")
      .sort((left, right) => Number(left.target_column || Infinity) - Number(right.target_column || Infinity))[0];
    const metrics = dynamicBreakthrough ? taskMetrics(dynamicBreakthrough, plan, input) : null;
    const baselineFrontier = Number(dynamicBreakthrough?.baseline_metrics?.global_farthest_scoring_column || 34);
    const currentFrontier = Number(metrics?.global_farthest_scoring_column || 34);
    const destinationColumn = Number(String(action.destination || action.path?.at(-1) || "").slice(0, 2));
    if (dynamicBreakthrough
      && currentFrontier > baselineFrontier
      && Number.isFinite(destinationColumn)
      && destinationColumn >= currentFrontier) {
      const assignedToBreakthrough = (dynamicBreakthrough.assigned_units || []).includes(action.unit);
      const existingIndex = matching.indexOf(dynamicBreakthrough);
      if (existingIndex >= 0) matching.splice(existingIndex, 1);
      matching.unshift(dynamicBreakthrough);
      dynamicSpearheadReassignment = !assignedToBreakthrough;
    }
  }
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
  else if (["preserve_force", "advance", "breakthrough_step"].includes(task.type)
    && state.scenario === "october"
    && plan.side === "axis") {
    const current = taskMetrics(task, plan, input);
    const baseline = task.baseline_metrics || current;
    ({ progress, completed, evidence } = withdrawalEvidence(task, current, baseline));
    if (progress <= Number(task.progress || 0) && !completed) {
      return { changed: false, reason: "withdrawal_task_has_no_exit_progress", task_id: task.id, task_type: task.type };
    }
  }
  else if (["advance", "breakthrough_step"].includes(task.type)) {
    const positionalGain = Number(evaluation.progress || 0) > 0;
    const scoringGain = Number(impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta ?? 0) > 0;
    const supplyEligible = state.scenario !== "july"
      ? ["supplied", "partially_supplied", "partial"].includes(impact.projected_supply_after_move)
      : impact.maintains_july_scoring_supply === true
      || ["supplied", "partially_supplied"].includes(impact.projected_supply_after_move);
    if ((!positionalGain && !scoringGain) || (task.type === "breakthrough_step" && !supplyEligible)) {
      return { changed: false, reason: supplyEligible ? "move_did_not_advance_objective" : "breakthrough_move_not_scoring_supplied", task_id: task.id, task_type: task.type };
    }
    const achievedColumn = task.type === "breakthrough_step"
      ? Number(taskMetrics(task, plan, input).global_farthest_scoring_column || 0)
      : scoringFrontierForSide(input, "axis");
    completed = task.type === "breakthrough_step"
      && Number(achievedColumn || 0) >= Number(task.target_column || Infinity);
    progress = completed ? 1 : Math.max(progress, scoringGain ? 0.8 : 0.25);
    evidence = completed
      ? `rule-grounded supplied Axis scoring frontier reached column ${achievedColumn}`
      : scoringGain ? `projected VP change ${impact.projected_vp_delta_from_current_state ?? impact.estimated_vp_delta}` : `objective distance improved by ${evaluation.progress}`;
  }
  else if (task.type === "preserve_supply") {
    if (state.scenario === "july" && impact.maintains_july_scoring_supply !== true) return { changed: false, reason: "action_did_not_confirm_supply_preservation", task_id: task.id, task_type: task.type };
    if (state.scenario !== "july" && !["supplied", "partially_supplied", "partial"].includes(impact.projected_supply_after_move)) {
      return { changed: false, reason: "action_did_not_confirm_supply_preservation", task_id: task.id, task_type: task.type };
    }
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
    const current = taskMetrics(task, plan, input);
    const newMines = current.cleared_mine_ids.filter((id) => !(task.baseline_metrics?.cleared_mine_ids || []).includes(id));
    const clearDetails = stepRecord?.action_applied?.result?.details
      || stepRecord?.action_applied?.result?.mine_clearance
      || {};
    const clearSucceeded = newMines.length > 0 || clearDetails.cleared === true && (clearDetails.removed || []).length > 0;
    const cleared = clearSucceeded || !!combatOutcome?.target_threat_reduced;
    if (!cleared) return { changed: false, reason: "blocker_not_cleared", task_id: task.id, task_type: task.type };
    progress = 1;
    completed = true;
    evidence = clearSucceeded ? `minefield removed: ${newMines.join(", ") || clearDetails.removed.join(", ")}` : combatOutcome.evidence.join("; ");
  }
  else if (task.type === "model_task") {
    // October west-edge extraction is itself the state-changing action. It
    // must count as progress so the task ledger agrees with the game ledger.
    if (!["move", "combat", "clear_mine", "exit_west"].includes(action.type)) {
      return { changed: false, reason: "model_task_requires_a_state_changing_action", task_id: task.id, task_type: task.type };
    }
    const currentMetrics = taskMetrics(task, plan, input);
    const modelEvidence = modelTaskEvidence(
      task,
      currentMetrics,
      task.baseline_metrics || currentMetrics,
      input,
      action,
      combatOutcome,
      impact
    );
    if (modelEvidence.progress <= Number(task.progress || 0) && !modelEvidence.completed) {
      return {
        changed: false,
        reason: "accepted_action_has_no_observable_model_task_progress",
        task_id: task.id,
        task_type: task.type,
        evidence: modelEvidence.evidence
      };
    }
    progress = modelEvidence.progress;
    completed = modelEvidence.completed;
    evidence = modelEvidence.evidence;
  }
  else return { changed: false, reason: "task_has_no_local_progress_predicate", task_id: task.id, task_type: task.type };
  task.progress = Number(progress.toFixed(2));
  task.progress_value = task.progress;
  task.progress_evidence = evidence;
  task.next_action = completed ? "等待下一任务激活" : "等待下一局面确认本次行动结果";
  task.last_action_step = Number(input?.step || 0);
  task.last_action_type = action.type;
  if (completed) task.status = "completed";
  activateTasks(plan, 3, input);
  const parentDone = updateParentState(plan);
  const actionFeedback = taskActionFeedback(plan, input, stepRecord, task, progress, evidence);
  return {
    changed: true,
    task_id: task.id,
    task_type: task.type,
    progress: task.progress,
    evidence,
    status_before: statusBefore,
    status_after: task.status,
    action_matched_inactive_task: false,
    action_feedback: actionFeedback,
    execution_source: dynamicSpearheadReassignment ? "dynamic_spearhead_reassignment" : "task_assignment",
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
  const clearDetails = stepRecord?.action_applied?.result?.details
    || stepRecord?.action_applied?.result?.mine_clearance
    || {};
  if (clearDetails.cleared === true && (clearDetails.removed || []).length) events.push("mine_cleared");
  if (combatOutcome?.target_threat_reduced) events.push("combat_target_threat_reduced");
  if (combatOutcome?.defender_supply_worsened?.length) events.push("enemy_supply_worsened");
  if (combatOutcome?.own_force_harmed) events.push("own_force_harmed");
  if ((stepRecord?.action_effect?.combat_opportunities_gained || []).length) events.push("new_tactical_opportunity");
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
  if (progress?.parent_completed || progress?.status_after === "completed" && progress?.status_before !== "completed") events.push("task_completed");
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
  if (events.includes("new_tactical_opportunity")) immediate.add("new_tactical_opportunity");
  const selected = events.filter((event) => immediate.has(event));
  if (events.includes("no_task_progress") && consecutiveNoProgress >= noProgressThreshold) {
    selected.push("repeated_no_task_progress");
  }
  if (progress?.action_matched_inactive_task) selected.push("inactive_task_action");
  return [...new Set(selected)];
}

function updateTaskExecutionHistory(plan, stepRecord, input) {
  const feedback = [];
  const tacticalFailures = new Set(["path_unavailable", "policy_rejection", "rule_rejection"]);
  for (const event of stepRecord.execution_ledger?.events || []) {
    const task = plan.children.find((item) => item.id === event.task_id)
      || plan.children.find((item) => item.assigned_units?.includes(event.unit));
    if (!task) continue;
    task.execution_history ||= [];
    if (task.execution_history.some((item) => item.event_id === event.event_id)) continue;
    if (!["attempt", "held", "skipped_after_repair", "repair_result", "executed", "execution_stopped"].includes(event.status)) continue;
    const failed = event.status === "attempt" && event.accepted === false && tacticalFailures.has(event.failure_class);
    task.execution_history.push({ event_id: event.event_id, step: input?.step, status: event.status,
      failure_class: event.failure_class || null, reason: event.reason || "", tactical_failure: failed });
    if (failed) task.consecutive_execution_failures = Number(task.consecutive_execution_failures || 0) + 1;
    if (event.status === "executed") {
      task.consecutive_execution_failures = 0;
      task.execution_blocked = false;
    }
    feedback.push({ task_id: task.id, event_id: event.event_id, tactical_failure: failed,
      reason: event.reason || event.status, blocked: false });
  }
  for (const task of plan.children) {
    const hasRemaining = (stepRecord.phase_unit_plan?.unit_orders || []).some((order) =>
      (order.task_id === task.id || task.assigned_units?.includes(order.unit))
      && (["pending", "needs_repair"].includes(order.status)
        || (order.status === "failed_pending" && !stepRecord.execution_ledger?.batch_repair_attempted)));
    if (Number(task.consecutive_execution_failures || 0) >= 2 && !hasRemaining && !isTerminalTask(task)) {
      task.status = "blocked";
      task.execution_blocked = true;
      task.blocked_phase_id = `${input?.turn}:${input?.phase}:${input?.side}`;
      task.last_blocked_reason = "two evidenced execution failures with no feasible remaining order";
      feedback.push({ task_id: task.id, blocked: true, reason: task.last_blocked_reason });
    }
  }
  return feedback;
}

function taskPlanSnapshot(plan) {
  if (!plan) return null;
  // Full history stays in the manager and final audit, not every prompt/snapshot.
  return clone({ ...plan, children: (plan.children || []).map((task) => {
    const history = task.execution_history || [];
    return { ...task, execution_history: history.slice(-8), execution_history_summary: {
      total_events: history.length,
      tactical_failures: history.filter((event) => event.tactical_failure).length,
      last_event_id: history.at(-1)?.event_id || null,
      truncated: history.length > 8,
      full_history_source: "execution_ledger_and_final_task_settlement"
    } };
  }) });
}

function createTaskManager({
  executionLedger = false,
  taskProtocol = "",
  maxActiveChildTasks = 3,
  maxChildTasks = 6,
  taskGeneration: managerTaskGeneration = "fixed_skeleton",
  scoringAnchorPolicy = "none",
  noProgressThreshold = 3,
  blockedThreshold = 2,
  supplyWorsenedThreshold = 2,
  lowOddsThreshold = 2,
  replanCooldownActions = 3,
  passiveHoldThreshold = 3,
  replanOnNewTacticalOpportunity = true
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
  let archives = [];
  const completedOperationalGoals = new Set();
  const strategicEvents = new Set();
  function recordStrategicEvent(reason, evidence, input, identity = evidence) {
    const key = fingerprint({ reason, identity });
    if (strategicEvents.has(key)) return;
    strategicEvents.add(key);
    plan.strategic_events ||= [];
    plan.strategic_events.push({ event_id: key, reason, evidence: clone(evidence), turn: input.turn, step: input.step });
    if (!replanReason) replanReason = reason;
  }
  function reconsiderObservedState(input) {
    if (!executionLedger) return;
    const state = input.state || input.ctx?.state || {};
    const regime = state.scenario === "october" ? (Number(state.turn) > 10 ? "withdrawal_open" : "withdrawal_preparation") : state.scenario;
    if (plan.observed_regime && plan.observed_regime !== regime) recordStrategicEvent("scenario_action_window_changed",
      { before: plan.observed_regime, after: regime }, input, regime);
    plan.observed_regime = regime;
    const scoringAnchor = plan.children?.find((task) => task.type === "preserve_scoring_anchor");
    if (scoringAnchor?.scoring_anchor_state === "lost" && !isFinalEvaluation(input)) {
      recordStrategicEvent("scoring_anchor_lost", {
        task_id: scoringAnchor.id,
        from: "secured",
        to: "lost",
        loss_count: scoringAnchor.scoring_anchor_loss_count,
        frontier: scoringAnchor.current_metrics?.global_farthest_scoring_column ?? null,
        target_column: scoringAnchor.target_column,
        evidence: scoringAnchor.progress_evidence
      }, input, {
        task_id: scoringAnchor.id,
        loss_count: scoringAnchor.scoring_anchor_loss_count
      });
    }
    for (const goal of [plan.goal_plan?.primary_goal, plan.goal_plan?.campaign_goal].filter(Boolean)) {
      const result = groundedGoalCompleted(plan, input, goal);
      const breaches = result.evidence.filter((item) => item.actual != null && item.target != null
        && ["at_most", "keep_below"].includes(item.relation)
        && (item.relation === "keep_below" ? item.actual >= item.target : item.actual > item.target));
      if (breaches.length) recordStrategicEvent("goal_constraint_breached", breaches, input,
        { metric: goal.metric, target: goal.target, target_vp: goal.target_vp, target_column: goal.target_column, relation: goal.relation });
    }
    const primaryPriority = Math.min(...plan.children.filter((task) => !task.observation_only).map((task) => Number(task.priority || 99)));
    const failed = plan.children.filter((task) => !task.observation_only && task.status === "failed"
      && (task.required_for_parent || Number(task.priority || 99) === primaryPriority));
    if (failed.length) recordStrategicEvent("task_acceptance_failed", failed.map((task) => ({ id: task.id, evidence: task.failure_evidence })),
      input, failed.map((task) => ({ id: task.id, conditions: task.failure_criteria })));
  }
  function recordOperationalCompletion(result) {
    const goal = plan.goal_plan?.primary_goal || {};
    const key = fingerprint({ subject_side: goal.subject_side, metric: goal.metric,
      relation: goal.relation, target: goal.target, target_column: goal.target_column,
      target_vp: goal.target_vp, target_hex: goal.target_hex, target_units: goal.target_units,
      evaluation_scope: goal.evaluation_scope, observable_conditions: goal.observable_conditions });
    if (completedOperationalGoals.has(key)) return;
    completedOperationalGoals.add(key);
    plan.operational_goal_completed = true;
    plan.operational_goal_completion_key = key;
    plan.operational_goal_completion_evidence = result.evidence;
    replanReason = "operational_goal_completed";
  }
  const snapshot = () => executionLedger ? taskPlanSnapshot(plan) : clone(plan);
  return {
    get plan() { return plan ? snapshot() : null; },
    get archives() { return clone(archives); },
    get executionHistory() {
      return clone(Object.fromEntries((plan?.children || []).map((task) => [task.id, task.execution_history || []])));
    },
    initialize({ intent, operation, input, allocation, rawPlan, preserveParent = false, taskGeneration = managerTaskGeneration } = {}) {
      const skeleton = buildTaskSkeleton({
        intent,
        operation,
        state: input?.state,
        side: input?.side,
        maxChildTasks,
        scoringAnchorPolicy,
        taskGeneration: taskGeneration || managerTaskGeneration
      });
      const nextPlan = normalizeTaskPlan(rawPlan, skeleton, {
        state: input?.state,
        side: input?.side,
        allocation,
        maxChildTasks,
        taskGeneration
      });
      if (taskProtocol) nextPlan.protocol = taskProtocol;
      for (const task of nextPlan.children) {
        task.require_acceptance_contract = taskProtocol === "side-aware-task-v4" && task.source === "model";
        if (task.require_acceptance_contract && !task.completion_criteria) task.completion_criteria = { all: [{ metric: "unverified", target: null }] };
        task.original_assigned_units = [...task.assigned_units];
      }
      nextPlan.strategic_events = clone(plan?.strategic_events || []);
      nextPlan.observed_regime = input?.state?.scenario === "october"
        ? (Number(input?.turn) > 10 ? "withdrawal_open" : "withdrawal_preparation") : input?.state?.scenario;
      if (preserveParent && plan && (executionLedger || plan.parent?.state === "active")) {
        nextPlan.parent = {
          ...nextPlan.parent,
          id: plan.parent.id,
          started_turn: plan.parent.started_turn,
          started_vp: plan.parent.started_vp,
          state: plan.parent.state,
          previous_replan_count: Number(plan.parent.previous_replan_count || 0) + 1,
          previous_goal: plan.goal_plan?.primary_goal || null
        };
        nextPlan.operational_goal_completion_key = plan.operational_goal_completion_key || null;
        const previousByKey = new Map((plan.children || []).map((task) => [taskIdentity(task), task]));
        const semanticKey = (task) => JSON.stringify([task.type, task.model_task_type, task.metric,
          task.subject_side, task.relation, task.target, task.target_hex, task.target_column, task.evaluation_scope,
          task.completion_criteria, task.failure_criteria, task.acceptance_contract]);
        const reusedTasks = new Set();
        const remappedIds = new Map();
        for (const task of nextPlan.children) {
          const exact = previousByKey.get(taskIdentity(task));
          const previous = executionLedger
            ? exact && !reusedTasks.has(exact) && semanticKey(exact) === semanticKey(task) ? exact
              : plan.children.find((candidate) => !reusedTasks.has(candidate) && semanticKey(candidate) === semanticKey(task))
            : exact;
          if (!previous) continue;
          reusedTasks.add(previous);
          if (executionLedger) {
            remappedIds.set(task.id, previous.id);
            task.id = previous.id;
            task.baseline_metrics = clone(previous.baseline_metrics || {});
            task.original_assigned_units = clone(previous.original_assigned_units || previous.assigned_units);
            task.maintenance_breach = clone(previous.maintenance_breach || null);
            task.execution_history = clone(previous.execution_history || []);
            task.consecutive_execution_failures = Number(previous.consecutive_execution_failures || 0);
            task.last_blocked_reason = previous.last_blocked_reason;
          }
          const sameTarget = !["advance", "breakthrough_step"].includes(task.type)
            || Number(task.target_column || 0) === Number(previous.target_column || 0);
          task.progress = sameTarget ? Math.max(Number(task.progress || 0), Number(previous.progress || 0)) : 0;
          task.progress_value = task.progress;
          task.last_action_step = previous.last_action_step;
          task.last_action_type = previous.last_action_type;
          if (sameTarget) task.next_action = previous.next_action || task.next_action;
          if (sameTarget && isTerminalTask(previous)) task.status = previous.status;
        }
        if (executionLedger) {
          for (const task of nextPlan.children) {
            for (const key of ["dependencies", "depends_on"]) {
              if (Array.isArray(task[key])) task[key] = task[key].map((id) => remappedIds.get(id) || id);
            }
          }
          const archiveId = `task-plan-${archives.length + 1}`;
          archives.push({ archive_id: archiveId, step: input?.step, parent: clone(plan.parent), children: clone(plan.children) });
          nextPlan.task_history = [...(plan.task_history || []), { archive_id: archiveId, step: input?.step,
            parent_id: plan.parent.id, children: plan.children.map((task) => ({ id: task.id, status: task.status,
              progress: task.progress, failure_count: task.consecutive_execution_failures || 0 })) }];
        }
      }
      const previousAnchor = plan?.children.find((task) => task.type === "preserve_scoring_anchor");
      const nextAnchor = nextPlan.children.find((task) => task.type === "preserve_scoring_anchor");
      if (previousAnchor && nextAnchor) {
        const conflicting = nextPlan.children.find((task) => task !== nextAnchor && task.id === previousAnchor.id);
        if (conflicting) {
          const oldId = conflicting.id;
          do {
            conflicting.id += "_model";
          } while (nextPlan.children.some((task) => task !== conflicting && task.id === conflicting.id));
          for (const task of nextPlan.children) {
            for (const field of ["depends_on", "soft_depends_on"]) task[field] = (task[field] || []).map((id) => id === oldId ? conflicting.id : id);
            for (const dependency of task.conditional_dependencies || []) if (dependency.id === oldId) dependency.id = conflicting.id;
          }
          conflicting.normalization_corrections ||= [];
          conflicting.normalization_corrections.push({ correction: "reserved_monitor_id_renamed", requested: oldId, grounded: conflicting.id });
        }
        Object.assign(nextAnchor, clone(previousAnchor));
      }
      plan = nextPlan;
      if (nextAnchor) reconcileJulyScoringAnchor(nextAnchor, taskMetrics(nextAnchor, plan, input), input);
      plan.parent.started_turn = plan.parent.started_turn ?? Number(input?.turn || 0);
      plan.parent.started_vp = plan.parent.started_vp ?? (input?.state?.vp ?? input?.state?.victory_points ?? null);
      activateTasks(plan, maxActiveChildTasks, input);
      for (const task of plan.children) {
        if (!executionLedger || !task.baseline_metrics) task.baseline_metrics = taskMetrics(task, plan, input);
      }
      consecutiveNoProgress = 0;
      noProgressKey = "";
      consecutiveBlocked = 0;
      consecutiveSupplyWorsened = 0;
      consecutiveLowOdds = 0;
      cooldownActionsRemaining = preserveParent ? Math.max(0, Number(replanCooldownActions || 0)) : 0;
      lastReconciliation = [];
      return snapshot();
    },
    refresh(input) {
      if (!plan) return null;
      for (const task of plan.children) {
        task.original_assigned_units ||= [...task.assigned_units];
        task.assigned_units = task.assigned_units.filter((id) => input?.state?.units?.[id] && !input.state.units[id].eliminated);
        if (executionLedger && task.execution_blocked && task.blocked_phase_id !== `${input?.turn}:${input?.phase}:${input?.side}`) {
          task.execution_blocked = false;
          task.status = "pending";
          task.next_action = "Revalidate the previous blocked route in the new phase; prior failures remain in execution_history.";
        }
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
      const primaryGoal = groundedGoalCompleted(plan, input, plan.goal_plan?.primary_goal);
      const campaignGoal = groundedGoalCompleted(plan, input, plan.goal_plan?.campaign_goal);
      if (plan.parent.state === "completed") replanReason = "task_goal_completed";
      else if (primaryGoal.completed && campaignGoal.evidence.length > 0 && !campaignGoal.completed) {
        recordOperationalCompletion(primaryGoal);
      }
      reconsiderObservedState(input);
      return snapshot();
    },
    settle(input = {}) {
      if (!plan) return null;
      const settled = this.refresh(input);
      const finalEvaluation = isFinalEvaluation(input)
        || ["final_victory", "completed", "finished"].includes(String(input.status || ""));
      if (!finalEvaluation) return settled;
      for (const task of plan.children || []) {
        if (isTerminalTask(task)) {
          // A task can satisfy its completion predicate and later fail its
          // failure predicate. Preserve both facts explicitly instead of
          // leaving a misleading completion_evidence=met on a failed task.
          if (task.status === "failed" && !task.terminal_evaluation) {
            task.terminal_evaluation = {
              final_status: "failed",
              completion_evidence: clone(task.completion_evidence || null),
              failure_evidence: clone(task.failure_evidence || null),
              evidence_source: "pre_final_failure_condition"
            };
          }
          continue;
        }
        const result = evaluateObservableCriteria(task.completion_criteria, task, taskMetrics(task, plan, input), input);
        if (result) task.completion_evidence = result;
        if (result?.status === "met" && result.scope_ready) {
          task.status = "completed";
          task.terminal_reason = "task_conditions_met_at_final_evaluation";
        } else if (result?.status === "not_met" && result.scope_ready) {
          task.status = "failed";
          task.terminal_reason = "task_conditions_not_met_at_final_evaluation";
        } else {
          task.status = "skipped";
          task.verification_status = "unverified";
          task.terminal_reason = "task_completion_evidence_unavailable_at_final_evaluation";
        }
      }
      return snapshot();
    },
    observe(input, stepRecord) {
      if (!plan) return { progress: null, events: [] };
      const beforeProgress = Object.fromEntries((plan.children || []).map((task) => [task.id, {
        progress: Number(task.progress || 0),
        status: task.status,
        metric: task.progress_metric || ""
      }]));
      const progress = localTaskProgress(plan, input, stepRecord);
      const anchor = plan.children.find((task) => task.type === "preserve_scoring_anchor");
      if (anchor) reconcileJulyScoringAnchor(anchor, taskMetrics(anchor, plan, input), input);
      const events = taskEvents(input, stepRecord, progress).filter((event) => !executionLedger
        || !["excessive_passive_holds", "route_blocked"].includes(event));
      const executionFeedback = executionLedger ? updateTaskExecutionHistory(plan, stepRecord, input) : [];
      if (executionLedger) {
        for (const feedback of executionFeedback) {
          if (feedback.blocked) events.push("task_execution_blocked");
        }
        const onlyHoldOrInfrastructure = !(stepRecord.execution_ledger?.events || []).some((event) =>
          event.status === "executed" && event.canonical_action?.type !== "pass");
        if (stepRecord.execution_ledger && onlyHoldOrInfrastructure) {
          const index = events.indexOf("no_task_progress");
          if (index >= 0) events.splice(index, 1);
        }
      }
      const observedTask = progress?.task_id
        ? plan.children.find((task) => task.id === progress.task_id)
        : (plan.children || []).find((task) => task.status === "active" && !task.observation_only);
      const actionFeedback = taskActionFeedback(plan, input, stepRecord, observedTask, progress?.progress ?? null, progress?.evidence || "");
      plan.last_action_feedback = actionFeedback;
      plan.last_task_events = events;
      const taskProgressDelta = Object.fromEntries((plan.children || []).map((task) => {
        const before = beforeProgress[task.id] || { progress: 0, status: "" };
        const after = { progress: Number(task.progress || 0), status: task.status, metric: task.progress_metric || "" };
        return [task.id, {
          before: before.progress,
          after: after.progress,
          delta: Number((after.progress - before.progress).toFixed(2)),
          status_before: before.status,
          status_after: after.status,
          metric: after.metric,
          reason: after.progress > before.progress
            ? task.progress_evidence || "observable task evidence improved"
            : after.status !== before.status ? `status changed from ${before.status} to ${after.status}` : "no measurable task evidence change"
        }];
      }));
      plan.last_task_progress_delta = taskProgressDelta;
      const heldThisStep = stepRecord?.rolling_unit_action?.held_this_step || [];
      if (!executionLedger && plan.side === "allies" && heldThisStep.length >= passiveHoldThreshold && !events.includes("excessive_passive_holds")) {
        events.push("excessive_passive_holds");
      }
      const acceptedNonPass = !!acceptedAttempt(stepRecord) && (stepRecord?.final_action?.type || "") !== "pass";
      if (acceptedNonPass && cooldownActionsRemaining > 0) cooldownActionsRemaining -= 1;
      const activeTask = (plan.children || [])
        .filter((task) => task.status === "active" && !task.observation_only)
        .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
      const countsAsNoProgress = events.includes("no_task_progress");
      const progressKey = countsAsNoProgress
        ? `${observedTask?.id || activeTask?.id || plan.parent.id}:${progress.reason || "no_progress"}`
        : "";
      if (events.includes("phase_end") && stepRecord.phase_unit_plan) {
        // Keep the phase's accumulated evidence until its queued orders finish.
      }
      else if (!countsAsNoProgress || progressKey !== noProgressKey) {
        consecutiveNoProgress = countsAsNoProgress ? 1 : 0;
        noProgressKey = progressKey;
      }
      else consecutiveNoProgress += 1;
      consecutiveBlocked = events.includes("route_blocked") ? consecutiveBlocked + 1 : 0;
      consecutiveSupplyWorsened = events.includes("supply_worsened") ? consecutiveSupplyWorsened + 1 : 0;
      consecutiveLowOdds = events.includes("low_odds_attack") ? consecutiveLowOdds + 1 : 0;
      const modelCheckEvents = checkerEvents(events, progress, consecutiveNoProgress, noProgressThreshold);
      observations.push({ turn: input?.turn, step: input?.step, events, progress: clone(progress), action_feedback: clone(actionFeedback) });
      observations = observations.slice(-256);
      if (executionLedger) {
        const feasibleTasks = plan.children.filter((task) => !isTerminalTask(task) && !task.execution_blocked
          && taskDependenciesComplete(task, plan.children) && task.assigned_units?.length);
        if (progress.parent_completed || plan.parent.state === "completed") replanReason = "task_goal_completed";
        else if (plan.goal_plan?.primary_goal
          && groundedGoalCompleted(plan, input, plan.goal_plan.primary_goal).completed
          && (() => {
            const campaign = groundedGoalCompleted(plan, input, plan.goal_plan.campaign_goal);
            return campaign.evidence.length > 0 && !campaign.completed;
          })()) {
          const primaryGoal = groundedGoalCompleted(plan, input, plan.goal_plan.primary_goal);
          recordOperationalCompletion(primaryGoal);
        }
        else if (plan.parent.state === "failed") replanReason = "task_goal_failed";
        else if (executionFeedback.some((item) => item.blocked) && !feasibleTasks.length) replanReason = "task_all_active_blocked";
        else if (executionFeedback.some((item) => item.blocked)) activateTasks(plan, maxActiveChildTasks, input);
        if (!replanReason && cooldownActionsRemaining === 0) {
          const remaining = (stepRecord.phase_unit_plan?.unit_orders || []).some((order) => order.status === "pending");
          if (consecutiveSupplyWorsened >= supplyWorsenedThreshold) replanReason = "task_supply_worsened";
          else if (consecutiveLowOdds >= lowOddsThreshold) replanReason = "task_repeated_low_odds_attack";
          else if (consecutiveNoProgress >= noProgressThreshold && !remaining) replanReason = "task_no_progress";
        }
        reconsiderObservedState(input);
      }
      else if (cooldownActionsRemaining === 0) {
        if (progress.parent_completed || plan.parent.state === "completed") replanReason = "task_goal_completed";
        else if (events.includes("excessive_passive_holds")) replanReason = "task_excessive_passive_holds";
        else if (consecutiveLowOdds >= lowOddsThreshold) replanReason = "task_repeated_low_odds_attack";
        else if (consecutiveSupplyWorsened >= supplyWorsenedThreshold) replanReason = "task_supply_worsened";
        else if (consecutiveBlocked >= blockedThreshold) replanReason = "task_blocked";
        else if (consecutiveNoProgress >= noProgressThreshold
          && !(stepRecord.phase_unit_plan?.unit_orders || []).some((order) => ["pending", "needs_repair"].includes(order.status))) replanReason = "task_no_progress";
        else if (replanOnNewTacticalOpportunity && events.includes("new_tactical_opportunity")) replanReason = "task_new_tactical_opportunity";
      }
      return {
        progress,
        action_feedback: actionFeedback,
        events,
        checker_events: modelCheckEvents,
        reconciliation: clone(lastReconciliation),
        task_progress_delta: taskProgressDelta,
        execution_feedback: executionFeedback,
        replan_policy: {
          cooldown_actions_remaining: cooldownActionsRemaining,
          consecutive_no_progress: consecutiveNoProgress,
          consecutive_blocked: consecutiveBlocked,
          consecutive_supply_worsened: consecutiveSupplyWorsened,
          consecutive_low_odds_attacks: consecutiveLowOdds
        },
        plan: snapshot()
      };
    },
    applyCheck(checkResult) {
      if (!plan || !checkResult?.task_id) return null;
      if (checkResult.abstain || Number(checkResult.confidence || 0) < 0.5) return snapshot();
      const task = plan.children.find((item) => item.id === checkResult.task_id);
      if (!task) return null;
      // The checker is advisory. It cannot create completion, failure, or
      // blocking state; reconcileTaskState is the sole local authority for
      // statuses and machine-readable completion evidence.
      task.checker_assessment = {
        status: checkResult.task_status || "unknown",
        confidence: Number(checkResult.confidence || 0),
        progress: Number.isFinite(Number(checkResult.task_progress)) ? Number(checkResult.task_progress) : null,
        reason: safeText(checkResult.reason, "", 300),
        recorded_at_step: checkResult.step ?? null
      };
      if (checkResult.reason) task.last_checker_reason = safeText(checkResult.reason, "", 300);
      task.checker_campaign_outcome = checkResult.campaign_outcome || "";
      task.checker_local_task_outcome = checkResult.local_task_outcome || "";
      const requestedNextTask = checkResult.switch_to || checkResult.next_task;
      if (requestedNextTask) {
        const nextTask = plan.children.find((item) => item.id === requestedNextTask);
        if (nextTask && taskDependenciesComplete(nextTask, plan.children)) {
          task.checker_suggested_switch = {
            to: nextTask.id,
            reason: safeText(checkResult.reason, "checker selected an existing task", 300),
            executable: true
          };
        } else {
          task.checker_suggested_switch = {
            to: String(requestedNextTask),
            reason: "requested task switch target is not currently executable",
            executable: false
          };
        }
      }
      return snapshot();
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
      archives = [];
      completedOperationalGoals.clear();
      strategicEvents.clear();
    }
  };
}

module.exports = {
  evaluateObservableCriteria,
  CHILD_STATES,
  PARENT_STATES,
  TASK_TYPES,
  buildTaskSkeleton,
  createTaskManager,
  normalizeTaskPlan,
  dependencyStatus,
  modelTaskEvidence,
  taskActionFeedback,
  phaseDispatchTasks,
  axisTacticalOpportunities,
  axisCombatPreparation,
  alliedDefensePosture,
  frontierBreakthroughPlan,
  reconcileTaskState,
  taskEvents,
  groundedGoalCompleted,
  taskPlanSnapshot,
  updateTaskExecutionHistory,
  evaluateObservableCriteria,
  localTaskProgress
};
