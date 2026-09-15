"use strict";

const RulesEngine = require("../../rule_engine.js");

const MOVEMENT_PHASES = new Set(["initial_movement", "mechanized_movement", "supply_movement"]);

function phaseKind(phase) {
  return String(phase || "").replace(/^axis_/, "").replace(/^allies_/, "");
}

function units(state = {}) {
  return Object.entries(state.units || {}).map(([id, unit]) => ({ id, ...unit }));
}

function hasCombatMineClearance(state = {}) {
  const side = state.active_side;
  const context = { state };
  return units(state).some((unit) => unit.side === side && !unit.eliminated && unit.hex
    && RulesEngine.isCombatUnit(unit)
    && RulesEngine.enemyMinesAt(context, side, unit.hex).length > 0
    && !unit.mine_cleared_this_turn && !unit.cleared_mine_this_turn && !unit.just_cleared_mine_hex);
}

function hasWestExit(state = {}) {
  if (state.scenario !== "october" || state.active_side !== "axis" || Number(state.turn || 1) <= 10) return false;
  return units(state).some((unit) => unit.side === "axis" && !unit.eliminated && unit.hex
    && (RulesEngine.isCombatUnit(unit) || RulesEngine.isSupplyUnit(unit))
    && (() => {
      try { return Number(RulesEngine.normalizeHex(unit.hex).slice(0, 2)) === 1; }
      catch { return false; }
    })());
}

function phaseAllowedActions(state = {}) {
  const kind = phaseKind(state.phase);
  if (kind === "combat") return ["combat", ...(hasCombatMineClearance(state) ? ["clear_mine"] : []), "pass"];
  if (!MOVEMENT_PHASES.has(kind)) return ["pass"];
  return ["move_intent", "move", ...(hasWestExit(state) ? ["exit_west"] : []), "pass"];
}

function scenarioPolicy(state = {}) {
  const scenario = String(state.scenario || "july");
  const side = String(state.active_side || "axis");
  const turn = Number(state.turn || 1);
  if (scenario === "july") return {
    id: "july-scoring-frontier-v1", scenario, side,
    phase_focus: side === "axis" ? "推进并保持计分补给" : "阻断 Axis 计分推进并保存防线",
    primary_metric: "scoring_frontier",
    action_priorities: side === "axis" ? ["supplied_frontier_move", "protect_supply", "remove_blocker", "favorable_combat", "preserve_force"] : ["block_frontier", "cut_axis_supply", "preserve_force", "favorable_counterattack"],
    phase_objectives: side === "axis" ? {
      initial_movement: "把主攻单位推进到下一有效计分列，并在移动后保持补给",
      mechanized_movement: "用机械化单位扩大已建立的补给推进轴，不牺牲突破部队",
      supply_movement: "提高下一计分列主攻单位的补给覆盖，避免为无计分位置移动",
      combat: "只攻击能清除计分前沿阻挡、削弱敌方或保护突破轴的合法目标"
    } : {
      initial_movement: "封锁 Axis 下一有效计分列，保持 Allied 防线和补给",
      mechanized_movement: "用机动力量填补突破口或切断 Axis 计分补给",
      supply_movement: "维持阻断线和关键 Allied 单位的补给",
      combat: "优先攻击能降低 Axis 计分威胁且不会无谓损失 Allied 单位的目标"
    },
    supply_meaning: "只有补给合格的 Axis 地面战斗单位跨越新的有效计分列才产生推进 VP。",
    pass_rule: "仍存在可验证的计分推进或阻断动作时，不应提前结束阶段。",
    special_constraints: ["initial_box_restrictions", "scoring_supply_requirement", "frontier_not_landmark"]
  };
  if (scenario === "september") return {
    id: "september-mine-clearance-v1", scenario, side,
    phase_focus: side === "axis" ? "接近并清除 Allied 雷区" : "保护雷区并阻止 Axis 清雷",
    primary_metric: "mine_clearance",
    action_priorities: side === "axis" ? ["legal_mine_clearance", "engineer_route", "protect_engineers", "maintain_clearance_supply", "favorable_combat"] : ["protect_minefield", "block_engineer_route", "cut_axis_supply", "preserve_force", "conditional_counterattack"],
    phase_objectives: side === "axis" ? {
      initial_movement: "让工兵合法进入雷区并形成后续清雷路线，同时保持工兵和支援单位补给",
      mechanized_movement: "保护清雷路线并把后续战斗力量移到已清除或可利用的通道",
      supply_movement: "为工兵和清雷后的主力保持补给，不把移动距离误当作得分",
      combat: "检查清雷机会和战斗赔率；清雷或解除阻挡优先于无收益攻击"
    } : {
      initial_movement: "保护雷区和工兵通道，阻止 Axis 获得合法清雷位置",
      mechanized_movement: "封锁 Axis 工兵和清雷主攻路线，同时保留机动防守力量",
      supply_movement: "保持雷区防线和关键 Allied 单位补给，避免被 Axis 绕过",
      combat: "只在能保护雷区、破坏清雷路线或降低 Axis 威胁时反击"
    },
    supply_meaning: "补给支持工兵、清雷单位和后续突破；移动本身不产生 September VP。",
    pass_rule: "存在合法清雷、保护雷区或能改变清雷路线的动作时，不应仅按推进距离 pass。",
    special_constraints: ["engineer_entry_clears_on_initial_movement", "combat_unit_clearance_roll", "three_vp_per_cleared_mine"]
  };
  if (scenario === "october") {
    const open = turn > 10;
    return {
      id: "october-west-withdrawal-v1", scenario, side,
      phase_focus: side === "axis" ? (open ? "执行合法西侧撤退并保存高价值单位" : "保存兵力并准备西侧撤退") : (open ? "阻断 Axis 西侧撤退收益" : "破坏撤退准备并保存 Allied 防线"),
    primary_metric: "withdrawal_vp",
    action_priorities: side === "axis" ? (open ? ["legal_west_exit", "protect_exit_route", "preserve_high_value_force", "maintain_supply"] : ["preserve_high_value_force", "prepare_west_route", "maintain_supply", "avoid_illegal_west_move"]) : ["block_west_exit", "disrupt_axis_supply", "preserve_force", "conditional_counterattack"],
      phase_objectives: side === "axis" ? {
        initial_movement: open ? "把可合法撤出的高价值单位送到西边出口，并检查每个单位的撤出资格" : "保存高价值 Axis 单位并准备合法西侧撤退路线，不提前违反撤退线规则",
        mechanized_movement: open ? "优先安排仍能合法撤出的机动单位，保持撤退路线畅通" : "利用机械化机动保存部队和撤退通道，不把向西移动本身当作 VP",
        supply_movement: open ? "先撤出有直接价值的 Axis 补给单位，再维持仍在地图上的部队补给" : "保存补给网络和可撤退单位，避免无必要的西向非法移动",
        combat: "仅在能保护撤退路线、降低阻断威胁或避免更大损失时战斗"
      } : {
        initial_movement: open ? "封锁 Axis 西侧出口和合法撤退路线，同时保存 Allied 防线" : "破坏 Axis 撤退准备并保持阻断位置，不追逐而放弃防线",
        mechanized_movement: open ? "用机动力量封锁西侧出口或切断 Axis 撤退单位的补给" : "建立可持续的西侧封锁，保留机动反应力量",
        supply_movement: "维持封锁部队补给，不为了追击而让 Allied 防线孤立",
        combat: "只在能降低 Axis 撤退 VP 或解除关键封锁威胁时反击"
      },
      supply_meaning: "补给影响单位战斗和生存价值；移动到西边本身不等于获得撤退 VP。",
      pass_rule: open ? "Axis 仍有合法高价值撤出机会时不要 pass；Allies 仍有可验证的封锁动作时不要 pass。" : "第 10 回合前优先保存部队和撤退通道，不要把非法西移当作撤退。",
      special_constraints: ["withdrawal_after_turn_ten", "west_edge_required", "pre_withdrawal_line_restrictions"]
    };
  }
  return { id: "generic-scenario-policy-v1", scenario, side, phase_focus: "遵循权威场景计分规则", primary_metric: "scenario_scoring", action_priorities: ["rule_verified_objective", "supply", "preserve_force"], supply_meaning: "按权威场景规则解释补给影响。", pass_rule: "没有规则支持的有效动作时才结束阶段。", special_constraints: [] };
}

function actionGuidance(state = {}, action = {}) {
  const scenario = String(state.scenario || "july");
  const side = String(state.active_side || "axis");
  if (scenario === "july") return { objective: action.type === "combat" ? (side === "axis" ? "清除计分前沿阻挡或降低敌方威胁" : "降低 Axis 计分威胁") : (side === "axis" ? "推进计分前沿或保护计分补给" : "阻断计分前沿或保护 Allied 防线"), direct_vp: "仅满足 July 计分列和补给条件时", side };
  if (scenario === "september") return { objective: action.type === "clear_mine" ? (side === "axis" ? "尝试清除当前 Allied 雷区" : "阻止 Axis 清除当前雷区") : action.type === "combat" ? (side === "axis" ? "保护清雷路线或解除阻挡" : "保护雷区或阻断工兵路线") : (side === "axis" ? "接近雷区、保护工兵或保持清雷补给" : "保护雷区、阻断工兵或保持防线补给"), direct_vp: action.type === "clear_mine" ? "成功清雷后按规则实际结算" : "移动本身不加 VP", side };
  if (scenario === "october") return { objective: action.type === "exit_west" ? "执行合法西侧撤出" : side === "axis" ? "准备合法撤退或保存部队" : "封锁 Axis 撤退路线并降低撤退威胁", direct_vp: action.type === "exit_west" ? "按规则对合法撤出单位实际结算" : "移动本身不产生撤退 VP", side };
  return { objective: "执行当前场景的规则目标", direct_vp: "按权威规则结算" };
}

module.exports = { MOVEMENT_PHASES, phaseKind, phaseAllowedActions, scenarioPolicy, actionGuidance };
