"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const RulesEngine = require("../../rule_engine.js");
const { promptValue } = require("./prompt_registry.js");

const {
  getToolDefinitions,
  resolveToolProfile,
  toolProfileHash
} = require("./agent_tools.js");
const {
  buildContext,
  evaluateManeuverTool,
  evaluateProbeAction,
  finalActionReview,
  mapHexState,
  mapRegionHexes,
  publicPayload,
  renderConnectionMap,
  runTool
} = require("../experiments/external_ai_transcript.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function supplyRank(value) {
  return { isolated: 0, unsupplied: 1, partial: 2, partially_supplied: 2, supplied: 3 }[String(value || "").toLowerCase()] ?? -1;
}

function oddsIndex(value) {
  return ["1-4", "1-3", "1-2", "1-1", "2-1", "3-1", "4-1", "5-1", "6-1", "7-1"].indexOf(String(value || ""));
}

function recoveryGuidance({ reason = "", assessment = {}, strategicReview = {} } = {}) {
  const text = `${reason} ${(strategicReview.issues || []).join(" ")}`.toLowerCase();
  const impact = assessment?.evaluation?.victory_impact || {};
  if (text.includes("projected supply") || text.includes("unsupplied") || text.includes("isolated")) {
    return "先不要重复提交同一路线。请先检查补给路径；可选择移动补给单位提高前沿覆盖、清除阻断补给的敌方 ZOC、改用仍能保持补给的单位，或执行侧翼保护/集结任务。只有确认目标格回合末仍为 supplied 或 partially_supplied 后再推进。";
  }
  if (text.includes("supply move would reduce") || Number(impact.supply_coverage?.delta || 0) < 0) {
    return "该补给移动会降低计分单位覆盖。请比较其他补给路径，优先选择覆盖增量为正且不会切断现有前沿补给的路线。";
  }
  if (text.includes("repeated destination") || text.includes("immediate reversal")) {
    return "该位置没有新增 VP、补给、ZOC 或堆叠收益。请改选能够推进当前任务、改善补给、脱离敌方 ZOC 或保护前沿的动作；若没有这类动作，再结束阶段。";
  }
  if (text.includes("no legal path") || text.includes("blocked")) {
    return "当前路线不可行。请先用 view_map 确认邻接和阻挡，再选择另一条合法路线、处理阻挡单位，或转入补给和侧翼保护任务。";
  }
  if (text.includes("odds") || text.includes("2-1")) {
    return "当前攻击赔率不足。请按目标查看可攻击单位，选择能够合法协同且赔率至少达到 2-1 的攻击者子集；如果不存在，应保留兵力并提交 pass，不要重复尝试同一组合。";
  }
  return "请根据拒绝原因选择一个不同的、可验证的任务方向；不要重复提交相同动作。优先使用工具确认局面后调用 act。";
}

function reviewStrategicCombat({ decisionMode, action, assessment, operationState, candidates = [], state } = {}) {
  if (decisionMode !== "hierarchical_sae" || action?.type !== "combat") return { accept: true, issues: [], warnings: [], alternatives: [], exemptions: [] };
  const policy = operationState?.operation_policy || {};
  const attackerSide = state?.units?.[action.attackers?.[0]]?.side || "";
  const allied = attackerSide === "allies";
  const minimum = String(allied ? "3-1" : (policy.minimum_attack_odds || "2-1")).replace(":", "-");
  const actual = assessment?.evaluation?.odds_column || action?.verdict?.details?.odds_column || "";
  const actualIndex = oddsIndex(actual);
  const minimumIndex = oddsIndex(minimum);
  const impact = assessment?.evaluation?.victory_impact || {};
  const faces = assessment?.evaluation?.outcome_faces || {};
  const defensiveEffect = assessment?.evaluation?.defensive_effect || {};
  const turnsRemaining = Number(impact.turns_remaining || 99);
  const reason = String(action.reason || "").toLowerCase();
  const emergency = turnsRemaining <= 1
    && (reason.includes("emergency") || reason.includes("last") || reason.includes("vp") || reason.includes("only"))
    && (Number(faces.defender_eliminated || 0) > 0 || impact.vp_relevance === "primary_objective");
  if (emergency) {
    return { accept: true, issues: [], warnings: [], alternatives: [], exemptions: ["verified_last_turn_exception"] };
  }
  if (allied && Number(assessment?.evaluation?.expected_crt_score || 0) < 0
    && !(defensiveEffect.immediate_axis_frontier_threat && turnsRemaining <= 1)) {
    return {
      accept: false,
      issues: ["Allied attack has negative expected combat value without a verified final-turn Axis scoring threat"],
      warnings: [],
      alternatives: [],
      exemptions: []
    };
  }
  if (actualIndex < 0 || minimumIndex < 0 || actualIndex >= minimumIndex) {
    return { accept: true, issues: [], warnings: [], alternatives: [], exemptions: [] };
  }
  const twoToOneIndex = oddsIndex("2-1");
  if (allied && actualIndex >= twoToOneIndex
    && defensiveEffect.immediate_axis_frontier_threat
    && Number(assessment?.evaluation?.expected_crt_score || 0) >= 0) {
    return {
      accept: true,
      issues: [],
      warnings: ["Allied 2-1 attack accepted because local rules identify a supplied Axis frontier threat and expected CRT value is non-negative"],
      alternatives: [],
      exemptions: ["verified_frontier_threat_counterattack"]
    };
  }
  if (allied && !defensiveEffect.immediate_axis_frontier_threat) {
    return {
      accept: false,
      issues: ["Allied attack is below 3-1 and does not target an immediate supplied Axis scoring threat"],
      warnings: [],
      alternatives: [],
      exemptions: []
    };
  }
  const alternatives = candidates
    .filter((item) => item?.action?.type === "combat")
    .filter((item) => oddsIndex(item.evaluation?.odds_column || item.action?.verdict?.details?.odds_column) >= minimumIndex)
    .filter((item) => JSON.stringify(item.action) !== JSON.stringify(action))
    .slice(0, 3)
    .map((item) => ({ action: item.action, odds: item.evaluation?.odds_column || item.action?.verdict?.details?.odds_column, score: item.score }));
  return {
    accept: false,
    issues: [`combat odds ${actual || "unknown"} are below strategic minimum ${minimum}; add attackers or choose another target`],
    warnings: [],
    alternatives,
    exemptions: []
  };
}

function reviewStrategicMovement({ decisionMode, action, assessment, operationState, history = [], state, ctx } = {}) {
  if (decisionMode !== "hierarchical_sae" || action?.type !== "move") return { accept: true, issues: [], warnings: [], exemptions: [] };
  const unit = state?.units?.[action.unit] || {};
  const evaluation = assessment?.evaluation || {};
  const impact = evaluation.victory_impact || {};
  const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || "");
  const previousHex = history.length >= 2 ? history.at(-2) : "";
  const issues = [];
  const warnings = [];
  const exemptions = [];
  const estimatedVpDelta = Number(impact.estimated_vp_delta || 0);
  const isSupply = RulesEngine.isSupplyUnit({ id: action.unit, ...unit });
  const supplyImproved = supplyRank(impact.projected_supply_after_move) > supplyRank(impact.unit_supply_before_move);
  const supplyWorsened = supplyRank(impact.projected_supply_after_move) >= 0
    && supplyRank(impact.unit_supply_before_move) >= 0
    && supplyRank(impact.projected_supply_after_move) < supplyRank(impact.unit_supply_before_move);
  let leavesEnemyZoc = false;
  try {
    leavesEnemyZoc = !!ctx && !!unit.hex
      && RulesEngine.enemyZocSources(ctx, unit.side, unit.hex).size > 0
      && (evaluation.enemy_zoc_sources || []).length === 0;
  }
  catch {}
  if (estimatedVpDelta > 0) exemptions.push("direct_vp_gain");
  if (supplyImproved) exemptions.push("supply_improvement");
  if (leavesEnemyZoc) exemptions.push("leaves_enemy_zoc");
  if (unit.temporary_overstack) exemptions.push("mandatory_stack_repair");
  const explicitVerifiedDenial = unit.side === "allies"
    && Number(impact.axis_scoring_threat_delta || 0) < 0
    && /block|deny|prevent|axis|vp|supply|zoc|阻断|阻止|补给|计分/i.test(String(action.reason || ""));
  if (explicitVerifiedDenial) exemptions.push("verified_axis_scoring_denial");

  if (supplyWorsened && !isSupply) {
    warnings.push(`supply_worsened: projected unit supply changes from ${impact.unit_supply_before_move || "unknown"} to ${impact.projected_supply_after_move || "unknown"}; verify that the tactical gain justifies the risk`);
  }

  if (unit.side === "allies" && !isSupply
    && ["isolated", "unsupplied"].includes(String(impact.projected_supply_after_move || "").toLowerCase())
    && !exemptions.includes("verified_axis_scoring_denial")) {
    issues.push(`Allied move would leave the combat unit ${impact.projected_supply_after_move}; preserve the unit or establish supply before moving`);
  }
  if (unit.side === "allies" && Number(impact.axis_scoring_threat_delta || 0) > 0) {
    const released = (impact.released_axis_frontier_units || []).join(", ");
    if (!supplyImproved && !leavesEnemyZoc) {
      issues.push(`Allied move opens the defensive line and increases Axis scoring threat${released ? ` by releasing ${released}` : ""}`);
    }
    else warnings.push(`defensive_line_weakened: verify that force or supply preservation outweighs Axis threat increase ${impact.axis_scoring_threat_delta}`);
  }

  if (destination && previousHex && destination === previousHex && !isSupply && exemptions.length === 0) {
    issues.push(`immediate reversal to ${destination} repeats the unit's previous position without VP, supply, ZOC, or stack-repair benefit`);
  }
  if (destination
    && history.slice(0, -1).includes(destination)
    && destination !== previousHex
    && exemptions.length === 0) {
    issues.push(`repeated destination ${destination} has appeared in recent movement history without VP, supply, ZOC, or stack-repair benefit`);
  }
  if (isSupply && Number(impact.supply_coverage?.delta || 0) < 0) {
    issues.push(`supply move would reduce scoring-eligible combat coverage by ${Math.abs(Number(impact.supply_coverage.delta))} unit(s)`);
  }

  const primaryGoal = operationState?.goal_plan?.primary_goal || {};
  const scoringSupplyGoal = (primaryGoal.observable_conditions || [])
    .some((condition) => condition.kind === "scoring_frontier_at_least");
  const targetColumn = Number(primaryGoal.target_column || operationState?.target_column || 0);
  const destinationColumn = Number(String(destination).slice(0, 2));
  const role = operationState?.units?.[action.unit]?.role || "";
  const projectedSupply = String(impact.projected_supply_after_move || "").toLowerCase();
  if (scoringSupplyGoal
    && role === "spearhead"
    && (unit.kind || "ground") === "ground"
    && Number.isFinite(destinationColumn)
    && targetColumn > 0
    && destinationColumn >= targetColumn
    && !["supplied", "partially_supplied", "partial"].includes(projectedSupply)) {
    issues.push(`spearhead would enter or pass scoring column ${targetColumn} with projected supply ${projectedSupply || "unknown"}; this does not satisfy the grounded scoring goal`);
  }
  return { accept: issues.length === 0, issues, warnings, exemptions };
}

function reviewTaskDispatch({ decisionMode, action, assessment, operationState, candidates = [] } = {}) {
  if (decisionMode !== "hierarchical_sae" || !operationState?.phase_dispatch) {
    return { accept: true, issues: [], warnings: [], exemptions: [] };
  }
  const dispatch = operationState.phase_dispatch;
  const tacticalOpportunities = operationState.task_plan?.tactical_opportunities || {};
  if (action?.type === "pass" && operationState.task_plan?.side === "allies") {
    const phaseKind = dispatch.phase_kind;
    const combatOpportunity = phaseKind === "combat" && (tacticalOpportunities.counterattack?.length || 0) > 0;
    const movementOpportunity = ["initial_movement", "mechanized_movement"].includes(phaseKind)
      && (tacticalOpportunities.disrupt_axis_supply?.length || 0) > 0;
    if (combatOpportunity || movementOpportunity) {
      return {
        accept: false,
        issues: [combatOpportunity
          ? "Allied pass is blocked because a locally verified counterattack against an Axis scoring threat is available"
          : "Allied pass is blocked because a locally verified Axis supply-disruption move is available"],
        warnings: [],
        alternatives: combatOpportunity ? tacticalOpportunities.counterattack.slice(0, 3).map((item) => ({ action: { type: "combat", attackers: item.attackers, defender_hexes: item.defender_hexes }, score: 0 })) : [],
        exemptions: []
      };
    }
    return { accept: true, issues: [], warnings: [], exemptions: ["no_verified_allied_tactical_opportunity"] };
  }
  const allowed = new Set(dispatch.allowed_unit_ids || []);
  if (!allowed.size) return { accept: true, issues: [], warnings: [], exemptions: [] };
  const units = action.type === "combat" ? (action.attackers || []) : action.unit ? [action.unit] : [];
  if (!units.length || units.some((unit) => allowed.has(unit))) {
    return { accept: true, issues: [], warnings: [], exemptions: [] };
  }
  const activeCandidateExists = candidates.some((item) => {
    const candidate = item?.action || item;
    if (!candidate || candidate.type === "pass") return false;
    const candidateUnits = candidate.type === "combat" ? (candidate.attackers || []) : [candidate.unit];
    return candidateUnits.some((unit) => allowed.has(unit));
  });
  if (!activeCandidateExists) return { accept: true, issues: [], warnings: [], exemptions: ["no_current_task_unit_has_a_candidate"] };

  const evaluation = assessment?.evaluation || {};
  const impact = evaluation.victory_impact || {};
  const beforeSupply = supplyRank(impact.unit_supply_before_move);
  const afterSupply = supplyRank(impact.projected_supply_after_move);
  const odds = oddsIndex(evaluation.odds_column);
  const minimumOdds = oddsIndex(String(operationState?.operation_policy?.minimum_attack_odds || "2-1").replace(":", "-"));
  const tacticalReasons = [];
  if (Number(impact.estimated_vp_delta || 0) > 0 || ["direct", "primary_objective"].includes(impact.vp_relevance)) {
    tacticalReasons.push("direct_vp_or_objective_gain");
  }
  if (afterSupply > beforeSupply) tacticalReasons.push("supply_improvement");
  if (Number(evaluation.progress || 0) > 0 || impact.vp_relevance === "frontier_setup") {
    tacticalReasons.push("frontier_or_position_progress");
  }
  if (action.type === "combat" && odds >= 0 && minimumOdds >= 0 && odds >= minimumOdds) {
    tacticalReasons.push("acceptable_combat_odds");
  }
  if ((evaluation.tactical_tags || []).some((tag) => /contact|objective|block|zoc|supply/i.test(String(tag)))) {
    tacticalReasons.push("situational_tactical_gain");
  }
  const primary = dispatch.primary_task_id || "current task";
  return {
    accept: true,
    issues: [],
    warnings: [
      tacticalReasons.length
        ? `cross_task_dispatch: unit is outside ${primary} but the action has ${tacticalReasons.join(", ")}`
        : `cross_task_dispatch_without_detected_gain: unit is outside ${primary}; model choice is retained for tactical review`
    ],
    exemptions: [
      tacticalReasons.length ? "cross_task_tactical_gain" : "cross_task_model_discretion"
    ]
  };
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) reject(new Error("bridge request too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function bestFallback(built) {
  const candidate = built.publicContext.candidate_actions?.find((item) => item.action?.type !== "pass")
    || built.publicContext.candidate_actions?.[0];
  return clone(candidate?.action || { type: "pass", reason: "local fallback: no useful legal action" });
}

function bridgeToolDescriptions(profile) {
  return getToolDefinitions(profile).map((tool) => ({
    name: tool.name,
    description: tool.description,
    purpose: tool.purpose,
    input_guide: tool.input_guide,
    output_guide: tool.output_guide,
    decision_effect: tool.decision_effect,
    examples: tool.examples || [],
    arguments: tool.parameters
  }));
}

function createActionRuleBridge(config, options = {}) {
  const profile = resolveToolProfile(options.toolProfile || "map_and_action", options.toolProfileOptions);
  const hasHoldTool = profile.tools.includes("hold_unit") || profile.tools.includes("hold_units");
  const token = options.token || crypto.randomBytes(24).toString("base64url");
  const records = [];
  const phaseSnapshots = new Map();
  const phaseHeldUnits = new Map();
  const movementHistory = new Map();
  const rejectionMemory = new Map();
  let current = null;
  let server = null;
  let url = "";

  function prepareStep(input) {
    const decisionMode = input.decisionMode || input.decision_policy || "direct";
    const built = buildContext(config, {
      state: input.state,
      decisionMode,
      phaseIntent: input.phaseIntent,
      strategicIntent: input.strategicIntent,
      forceAllocation: input.forceAllocation,
      operationState: input.operationState,
      includeInitialMap: Number(input.step) === 1,
      privateCandidates: input.privateCandidates !== false
    });
    const policyCandidates = built.publicContext.candidate_actions || built.candidatePool || [];
    const payload = publicPayload(config, built.publicContext, []);
    payload.context.protocol.tool_call_shape = { name: profile.tools.join("|"), arguments: "tool-specific JSON" };
    payload.context.protocol.allowed_tools = [...profile.tools];
    payload.context.protocol.tool_profile = profile.id;
    payload.context.protocol.canonical_action_shapes = {
      move_intent: { type: "move_intent", unit: "unit-id", destination: "hex", mode: "auto" },
      combat: { type: "combat", attackers: ["unit-id"], defender_hexes: ["hex"] },
      exit_west: { type: "exit_west", unit: "unit-id" },
      pass: { type: "pass", reason: "short reason" }
    };
    payload.context.tools = bridgeToolDescriptions(profile);
    payload.context.decision_brief.tool_policy = hasHoldTool
      ? promptValue("context.tool_policy_rolling")
      : profile.tools.includes("check_combat")
        || profile.tools.includes("inspect_supply")
        || profile.tools.includes("phase_status")
      ? promptValue("context.tool_policy_tactical")
      : profile.tools.includes("view_map")
        ? promptValue("context.tool_policy_with_map")
      : profile.tools.includes("act")
        ? promptValue("context.tool_policy_act")
        : promptValue("context.tool_policy_other");
    current = {
      step: Number(input.step),
      turn: Number(input.turn),
      phase: input.phase,
      side: input.side,
      decisionMode,
      operationState: input.operationState || null,
      session_id: input.session_id || "",
      built,
      evaluationContext: {
        ...built.publicContext,
        // Candidates stay private in direct/intent mode but let the local judge
        // validate every action class, including October west exits.
        candidate_actions: policyCandidates
      },
      fallback: bestFallback({ publicContext: { candidate_actions: policyCandidates } }),
      has_non_pass: policyCandidates.some((item) => item.action?.type !== "pass"),
      proposals: new Map(),
      submitted: null,
      accepted_at_record: -1,
      tool_calls: 0,
      rejection_counts: new Map(),
      read_only_cache: new Map(),
      duplicate_read_only_calls: new Map()
    };
    for (const unit of current.built.allUnits) {
      if (!unit.hex || unit.eliminated) continue;
      const history = movementHistory.get(unit.id) || [];
      if (history.at(-1) !== unit.hex) history.push(unit.hex);
      movementHistory.set(unit.id, history.slice(-4));
    }
    const phaseKey = `${current.turn}:${current.phase}:${current.side}`;
    if (!phaseSnapshots.has(phaseKey)) phaseSnapshots.set(phaseKey, phaseEligibleUnits(built, current.side));
    if (!phaseHeldUnits.has(phaseKey)) phaseHeldUnits.set(phaseKey, new Map());
    payload.context.phase_status = phaseStatus();
    payload.context.movement_memory = Object.fromEntries(actionableUnits()
      .map((unit) => [unit.id, {
        current_hex: unit.hex,
        recent_positions: [...(movementHistory.get(unit.id) || [unit.hex])]
      }]));
    payload.context.decision_brief.phase_status_rule = "The latest authoritative phase_status is already included. Do not call phase_status again unless this snapshot is missing; proceed with act, hold_unit, or hold_units.";
    payload.context.decision_brief.movement_memory_rule = "Avoid returning a unit to its immediately previous position unless the move gains VP, improves supply, leaves enemy ZOC, or repairs mandatory stacking.";
    return {
      public_payload: payload,
      context_bytes: Buffer.byteLength(JSON.stringify(built.publicContext), "utf8"),
      fallback_action: clone(current.fallback),
      has_non_pass: current.has_non_pass,
      tool_profile: profile.id,
      tool_profile_hash: toolProfileHash(profile)
    };
  }

  function assertCurrent(sessionId) {
    if (!current) throw new Error("no active game step");
    if (sessionId && current.session_id && current.session_id !== sessionId) throw new Error("session does not own active game step");
  }

  function inspect(args = {}) {
    const env = { ctx: current.built.ctx, allUnits: current.built.allUnits };
    if (args.kind === "unit") return runTool(env, current.built.publicContext, "inspect_unit", { unit: args.target });
    if (args.kind === "hex") return runTool(env, current.built.publicContext, "inspect_hex", { hex: args.target });
    if (args.kind === "supply") return runTool(env, current.built.publicContext, "trace_supply", { unit: args.target });
    return { legal: false, reason: `unknown inspect kind ${args.kind || "<missing>"}` };
  }

  function actionableUnits() {
    const kind = current.built.publicContext.game?.phase_kind;
    return current.built.allUnits
      .filter((unit) => unit.side === current.side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
      .filter((unit) => {
        if ((unit.state || "fresh") !== "fresh") return false;
        if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
          return RulesEngine.canMoveInCurrentPhase(current.built.ctx, unit) && Number(unit.movement || 0) > 0;
        }
        if (kind === "combat") {
          return RulesEngine.canAttackUnit(unit) && !unit.attacked_this_turn && !unit.attacked_this_phase
            && !unit.mine_cleared_this_turn && !unit.cleared_mine_this_turn && !unit.just_cleared_mine_hex;
        }
        return false;
      })
      .map((unit) => ({
        id: unit.id,
        hex: unit.hex,
        kind: unit.kind || "ground",
        attack: Number(unit.attack || 0),
        defense: Number(unit.defense ?? unit.attack ?? 0),
        movement: Number(unit.movement || 0),
        state: unit.state || "fresh"
      }));
  }

  function phaseEligibleUnits(built, side) {
    const kind = built.publicContext.game?.phase_kind || RulesEngine.phaseKind(built.ctx.state.phase);
    return built.allUnits
      .filter((unit) => unit.side === side && RulesEngine.isMapCounter(unit) && !unit.eliminated && unit.hex)
      .filter((unit) => {
        if ((unit.state || "fresh") !== "fresh") return false;
        if (["initial_movement", "mechanized_movement", "supply_movement"].includes(kind)) {
          return RulesEngine.canMoveInCurrentPhase(built.ctx, unit) && Number(unit.movement || 0) > 0;
        }
        if (kind === "combat") {
          return RulesEngine.canAttackUnit(unit)
            && !unit.attacked_this_turn
            && !unit.attacked_this_phase
            && !unit.mine_cleared_this_turn
            && !unit.cleared_mine_this_turn
            && !unit.just_cleared_mine_hex;
        }
        return false;
      })
      .map((unit) => unit.id);
  }

  function combatTargetStatus(eligible) {
    const ctx = current.built.ctx;
    const byHex = RulesEngine.unitsByHex(ctx);
    const eligibleSet = new Set(eligible);
    const activeUnits = current.built.allUnits
      .filter((unit) => unit.side === current.side && RulesEngine.isCombatUnit(unit) && unit.hex && !unit.eliminated);
    const defenderHexes = new Set();
    for (const unit of activeUnits) {
      for (const hex of RulesEngine.neighbors(unit.hex)) {
        if ((byHex[hex] || []).some((other) => other.side !== current.side && RulesEngine.isCombatUnit(other) && !other.eliminated)) {
          defenderHexes.add(hex);
        }
      }
    }
    const unitIndex = new Map((current.built.publicContext.unit_index?.active || []).map((unit) => [unit.id, unit]));
    const reasonForUnavailable = (unit) => {
      if (!eligibleSet.has(unit.id)) {
        if ((unit.state || "fresh") !== "fresh") return "unit is no longer fresh";
        if (unit.attacked_this_turn || unit.attacked_this_phase) return "unit has already attacked this phase or turn";
        if (unit.mine_cleared_this_turn || unit.cleared_mine_this_turn || unit.just_cleared_mine_hex) return "unit performed a mine action and cannot attack now";
        if (!RulesEngine.canAttackUnit(unit)) return "unit type or current state cannot attack";
        return "unit is not eligible in the current combat phase";
      }
      return "current rules rejected this unit for the target";
    };
    const targets = [...defenderHexes].sort().map((targetHex) => {
      const defenders = (byHex[targetHex] || [])
        .filter((unit) => unit.side !== current.side && RulesEngine.isCombatUnit(unit) && !unit.eliminated)
        .map((unit) => ({
          id: unit.id,
          name: unit.name || unit.id,
          attack: Number(unit.attack || 0),
          defense: Number(unit.defense ?? unit.attack ?? 0),
          supply: RulesEngine.isPlayableSide(unit.side) ? (unitIndex.get(unit.id)?.sup || "") : "",
          state: unit.state || "fresh"
        }));
      const adjacent = activeUnits
        .filter((unit) => RulesEngine.neighbors(unit.hex).includes(targetHex));
      const attackers = [];
      const unavailable = [];
      for (const unit of adjacent) {
        const verdict = RulesEngine.checkCombat(ctx, { attackers: [unit.id], defender_hexes: [targetHex] });
        const indexed = unitIndex.get(unit.id) || {};
        const detail = {
          unit: unit.id,
          name: unit.name || unit.id,
          hex: unit.hex,
          attack: Number(unit.attack || 0),
          effective_attack: Number(RulesEngine.effectiveAttack(ctx, { ...unit, supply_state: indexed.sup || "" }) || unit.attack || 0),
          supply: indexed.sup || "",
          state: unit.state || "fresh",
          fresh: (unit.state || "fresh") === "fresh",
          adjacent: true,
          can_attack: verdict.legal
        };
        if (verdict.legal && eligibleSet.has(unit.id)) attackers.push(detail);
        else unavailable.push({ unit: unit.id, hex: unit.hex, reason: verdict.legal ? reasonForUnavailable(unit) : verdict.reason || reasonForUnavailable(unit) });
      }
      const terrain = RulesEngine.hexTags(ctx, targetHex);
      const defense = defenders.reduce((sum, unit) => sum + Number(unit.defense || 0), 0);
      return {
        target_hex: targetHex,
        defenders,
        defender_strength: defense,
        terrain,
        attackers_that_can_attack: attackers,
        unavailable_attackers: unavailable,
        joint_attack_rule: "Choose any subset or all of attackers_that_can_attack. Every chosen unit must remain adjacent, fresh, eligible, and pass the final act/check_combat validation. The final odds are calculated after the chosen subset is submitted.",
        has_attack: attackers.length > 0
      };
    });
    return {
      targets,
      rules: [
        "Units listed under one target may attack alone or combine with any subset of the other listed eligible units.",
        "The final attack ratio is total effective attack divided by defender strength after supply, terrain, mine, and other combat rules.",
        "Use check_combat for one proposed subset when the odds or CRT risk is uncertain; do not enumerate every combination.",
        "act is authoritative and rechecks adjacency, freshness, attack eligibility, odds, terrain, mines, and supply before execution."
      ]
    };
  }

  function phaseStatus() {
    const phaseKey = `${current.turn}:${current.phase}:${current.side}`;
    const eligible = phaseSnapshots.get(phaseKey) || [];
    const held = phaseHeldUnits.get(phaseKey) || new Map();
    const eligibleSet = new Set(eligible);
    const phaseKind = current.built.publicContext.game?.phase_kind || "";
    const movementPhase = ["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind);
    const currentlyActionable = actionableUnits().filter((unit) => eligibleSet.has(unit.id) && !held.has(unit.id));
    const hasLegalMove = new Map(currentlyActionable.map((unit) => {
      if (!movementPhase) return [unit.id, true];
      const reachable = RulesEngine.reachableHexes(current.built.ctx, unit.id, { mode: "normal", maxHexes: 2 });
      return [unit.id, [...reachable.keys()].some((hex) => hex !== unit.hex)];
    }));
    const remaining = currentlyActionable.filter((unit) => hasLegalMove.get(unit.id));
    const remainingIds = new Set(remaining.map((unit) => unit.id));
    const acted = eligible.filter((unitId) => {
      const unit = current.built.ctx.state.units?.[unitId];
      if (!unit || unit.eliminated || !unit.hex) return false;
      if (["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind)) {
        return (unit.state || "fresh") !== "fresh";
      }
      if (phaseKind === "combat") {
        return (unit.state || "fresh") !== "fresh" || unit.attacked_this_turn || unit.attacked_this_phase
          || unit.mine_cleared_this_turn || unit.cleared_mine_this_turn || unit.just_cleared_mine_hex;
      }
      return false;
    });
    const actedIds = new Set(acted);
    const unavailable = eligible.filter((unitId) => !remainingIds.has(unitId) && !actedIds.has(unitId) && !held.has(unitId));
    const mandatoryActions = movementPhase
      ? RulesEngine.temporaryOverstackGroups(current.built.ctx, current.side).map((group) => ({
        type: "stack_repair",
        hex: group.hex,
        units: [...(group.removable_unit_ids || [])],
        excess: Number(group.excess || 0),
        reason: "temporary overstack must be repaired before ordinary movement"
      }))
      : [];
    const hasLegalNonPass = mandatoryActions.length > 0 || remaining.length > 0;
    // Unit-by-unit completion is a movement protocol. Combat is voluntary and
    // may end immediately when no attack meets the current strategic policy.
    const canPass = !movementPhase || (mandatoryActions.length === 0 && remaining.length === 0);
    const combatStatus = phaseKind === "combat" ? combatTargetStatus(eligible) : null;
    return {
      ok: true,
      read_only: true,
      snapshot: {
        step: current.step,
        turn: current.turn,
        phase: current.phase,
        phase_kind: current.built.publicContext.game?.phase_kind || "",
        side: current.side
      },
      eligible_units: [...eligible],
      acted_units: acted,
      held_units: [...held.keys()],
      hold_reasons: Object.fromEntries(held),
      remaining_units: remaining.map((unit) => unit.id),
      unavailable_units: unavailable,
      remaining_unit_details: remaining,
      mandatory_actions: mandatoryActions,
      ...(combatStatus ? {
        combat_targets: combatStatus.targets,
        combat_rules: combatStatus.rules,
        combat_target_count: combatStatus.targets.length
      } : {}),
      has_legal_non_pass_action: hasLegalNonPass,
      can_pass: canPass,
      counts: {
        eligible: eligible.length,
        acted: acted.length,
        held: held.size,
        remaining: remaining.length,
        unavailable: unavailable.length,
        mandatory: mandatoryActions.length
      },
      advance_reason: mandatoryActions.length
        ? ""
        : remaining.length === 0
          ? unavailable.length
            ? "no_legal_non_pass_action"
            : "all_eligible_units_handled"
          : ""
    };
  }

  function reviewAlliedHold(unitId, reason) {
    if (current.side !== "allies" || current.decisionMode !== "hierarchical_sae") {
      return { accepted: true, defensive_role: "not_applicable", task_ids: [] };
    }
    const tasks = (current.operationState?.task_plan?.children || [])
      .filter((task) => (task.assigned_units || []).includes(unitId));
    const activeTasks = tasks.filter((task) => task.status === "active");
    const rolePattern = /block|line|screen|anchor|reserve|flank|supply|zoc|counter|preserv|protect|deny|hold.*route|阻断|防线|掩护|锚定|预备|侧翼|补给|控制区|反击|保存|保护|封锁/i;
    if (!rolePattern.test(reason)) {
      return {
        accepted: false,
        reason: `${unitId} hold lacks a concrete defensive role; name the blocking line, supply protection, reserve response, flank screen, force preservation, or counterattack purpose`
      };
    }
    // The task normalizer may keep a reserve pool implicit when the six-task
    // limit is full. An unassigned Allied unit is therefore a reserve unit,
    // not an invalid task reference.
    if (current.operationState?.task_plan && !tasks.length) {
      return { accepted: true, defensive_role: "reserve", task_ids: [] };
    }
    return {
      accepted: true,
      defensive_role: (activeTasks[0] || tasks[0])?.type || "defensive_hold",
      task_ids: tasks.map((task) => task.id)
    };
  }

  function holdUnit(args = {}) {
    const phaseKind = current.built.publicContext.game?.phase_kind || "";
    if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind)) {
      return { accepted: false, retryable: true, stop: false, reason: "hold_unit is available only in movement phases" };
    }
    const unitId = String(args.unit || "");
    const reason = String(args.reason || "").trim();
    const phaseKey = `${current.turn}:${current.phase}:${current.side}`;
    const eligible = phaseSnapshots.get(phaseKey) || [];
    const held = phaseHeldUnits.get(phaseKey) || new Map();
    if (!unitId || !eligible.includes(unitId)) {
      return { accepted: false, retryable: true, stop: false, reason: `${unitId || "<missing>"} is not eligible in this phase` };
    }
    if (!reason) return { accepted: false, retryable: true, stop: false, reason: "hold_unit requires a tactical reason" };
    const holdReview = reviewAlliedHold(unitId, reason);
    if (!holdReview.accepted) return { accepted: false, retryable: true, stop: false, reason: holdReview.reason };
    if (held.has(unitId)) {
      return { accepted: true, stop: false, unit: unitId, status: "held", idempotent: true, phase_status: phaseStatus() };
    }
    const unit = current.built.ctx.state.units?.[unitId];
    if (!unit || unit.eliminated || !unit.hex || (unit.state || "fresh") !== "fresh") {
      return { accepted: false, retryable: true, stop: false, reason: `${unitId} has already acted or is no longer available` };
    }
    const mandatory = RulesEngine.temporaryOverstackGroups(current.built.ctx, current.side)
      .find((group) => (group.removable_unit_ids || []).includes(unitId));
    if (mandatory) {
      return {
        accepted: false,
        retryable: true,
        stop: false,
        reason: `${unitId} must help repair temporary overstack at ${mandatory.hex}`
      };
    }
    held.set(unitId, reason.slice(0, 160));
    current.read_only_cache.clear();
    const status = phaseStatus();
    return {
      accepted: true,
      stop: false,
      unit: unitId,
      status: "held",
      defensive_role: holdReview.defensive_role,
      task_ids: holdReview.task_ids,
      phase_complete: status.can_pass,
      phase_status: status,
      instruction: status.can_pass
        ? "All eligible units are handled. Call act with pass to end the phase."
        : "Unit held. Choose another remaining unit."
    };
  }

  function holdUnits(args = {}) {
    const orders = Array.isArray(args.orders) ? args.orders : [];
    if (!orders.length) return { accepted: false, retryable: true, stop: false, reason: "hold_units requires at least one order" };
    const phaseKind = current.built.publicContext.game?.phase_kind || "";
    if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(phaseKind)) {
      return { accepted: false, retryable: true, stop: false, reason: "hold_units is available only in movement phases" };
    }
    const phaseKey = `${current.turn}:${current.phase}:${current.side}`;
    const eligible = phaseSnapshots.get(phaseKey) || [];
    const held = phaseHeldUnits.get(phaseKey) || new Map();
    const seen = new Set();
    const normalized = [];
    for (const order of orders) {
      const unitId = String(order?.unit || "");
      const reason = String(order?.reason || "").trim();
      if (!unitId || seen.has(unitId)) {
        return { accepted: false, retryable: true, stop: false, reason: `${unitId || "<missing>"} is missing or duplicated; no holds were applied` };
      }
      seen.add(unitId);
      if (!eligible.includes(unitId)) {
        return { accepted: false, retryable: true, stop: false, reason: `${unitId} is not eligible in this phase; no holds were applied` };
      }
      if (!reason) return { accepted: false, retryable: true, stop: false, reason: `${unitId} requires a tactical reason; no holds were applied` };
      const holdReview = reviewAlliedHold(unitId, reason);
      if (!holdReview.accepted) return { accepted: false, retryable: true, stop: false, reason: `${holdReview.reason}; no holds were applied` };
      const unit = current.built.ctx.state.units?.[unitId];
      if (!held.has(unitId) && (!unit || unit.eliminated || !unit.hex || (unit.state || "fresh") !== "fresh")) {
        return { accepted: false, retryable: true, stop: false, reason: `${unitId} has already acted or is no longer available; no holds were applied` };
      }
      const mandatory = RulesEngine.temporaryOverstackGroups(current.built.ctx, current.side)
        .find((group) => (group.removable_unit_ids || []).includes(unitId));
      if (mandatory) {
        return { accepted: false, retryable: true, stop: false, reason: `${unitId} must help repair temporary overstack at ${mandatory.hex}; no holds were applied` };
      }
      normalized.push({ unit: unitId, reason: reason.slice(0, 160), idempotent: held.has(unitId), holdReview });
    }
    for (const order of normalized) if (!order.idempotent) held.set(order.unit, order.reason);
    current.read_only_cache.clear();
    const status = phaseStatus();
    return {
      accepted: true,
      stop: false,
      units: normalized.map((order) => order.unit),
      newly_held: normalized.filter((order) => !order.idempotent).map((order) => order.unit),
      defensive_roles: Object.fromEntries(normalized.map((order) => [order.unit, order.holdReview.defensive_role])),
      phase_complete: status.can_pass,
      phase_status: status,
      instruction: status.can_pass
        ? "All eligible units are handled. Call act with pass to end the phase."
        : "Units held. Choose another remaining unit."
    };
  }

  function fallbackAction() {
    if (!current) return { type: "pass", reason: "local fallback" };
    if (!hasHoldTool) return clone(current.fallback);
    const status = phaseStatus();
    const phaseKind = current.built.publicContext.game?.phase_kind || "";
    const acceptCandidate = (candidate) => {
      if (!candidate) return null;
      const action = clone(candidate.action || candidate);
      try {
        const reviewed = reviewForExecution(action);
        if (!reviewed.assessment.legal || !reviewed.review.accept || !reviewed.strategicReview.accept) return null;
        return clone(reviewed.canonicalAction);
      }
      catch {
        return null;
      }
    };
    const combatFallbackReason = () => {
      const minimum = String(current.operationState?.operation_policy?.minimum_attack_odds || "2-1").replace(":", "-");
      return `local fallback: no combat meets strategic minimum ${minimum}`;
    };
    const held = new Set(status.held_units);
    const remainingUnit = status.remaining_unit_details?.find((unit) => !held.has(unit.id));
    if (remainingUnit) {
      const candidate = (current.evaluationContext.candidate_actions || []).find((item) => {
        const action = item.action || item;
        return action.type !== "pass" && action.unit === remainingUnit.id;
      });
      const acceptedCandidate = acceptCandidate(candidate);
      if (acceptedCandidate) return acceptedCandidate;
      const reachable = RulesEngine.reachableHexes(current.built.ctx, remainingUnit.id, { mode: "normal", maxHexes: 120 });
      const target = [...reachable.entries()]
        .filter(([hex, item]) => hex !== remainingUnit.hex && item.path?.length > 1)
        .sort((left, right) => Number(right[1].cost || 0) - Number(left[1].cost || 0))[0];
      if (target) {
        const generated = {
          type: "move",
          unit: remainingUnit.id,
          path: clone(target[1].path),
          mode: "normal",
          destination: target[0],
          reason: "local fallback: remaining eligible unit has a legal move"
        };
        const acceptedGenerated = acceptCandidate(generated);
        if (acceptedGenerated) return acceptedGenerated;
      }
    }
    const candidate = (current.evaluationContext.candidate_actions || []).find((item) => {
      const action = item.action || item;
      return action.type !== "pass" && (!action.unit || !held.has(action.unit));
    });
    const acceptedCandidate = acceptCandidate(candidate);
    if (acceptedCandidate) return acceptedCandidate;
    if (phaseKind === "combat" && current.decisionMode === "hierarchical_sae") {
      return { type: "pass", reason: combatFallbackReason() };
    }
    if (status.can_pass) return { type: "pass", reason: status.advance_reason || "rolling phase complete" };
    // A rolling movement phase cannot legally pass while a unit remains. Keep
    // the rule-generated legal action as the final execution guardrail.
    return acceptCandidate(current.fallback) || clone(current.fallback);
  }

  function combatContacts(units) {
    if (current.built.publicContext.game?.phase_kind !== "combat") return [];
    const byHex = RulesEngine.unitsByHex(current.built.ctx);
    return units.map((unit) => ({
      attacker: unit.id,
      attacker_hex: unit.hex,
      adjacent_enemy_hexes: RulesEngine.neighbors(unit.hex).filter((hex) =>
        (byHex[hex] || []).some((other) => other.side !== current.side && RulesEngine.isCombatUnit(other) && !other.eliminated))
    })).filter((item) => item.adjacent_enemy_hexes.length);
  }

  function recentRuleRejections() {
    return records
      .filter((record) => record.turn === current.turn && record.phase === current.phase && record.session_id === current.session_id
        && record.tool === "act" && !record.result?.accepted)
      .slice(-8)
      .map((record) => ({
        step: record.step,
        action: record.arguments?.action || {},
        reason: record.result?.reason || "rejected",
        repeated_rejection_count: Number(record.result?.repeated_rejection_count || 1)
      }));
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    return value;
  }

  function actionSignature(action) {
    return JSON.stringify(stableValue(action || {}));
  }

  function relevantStateFingerprint(action = {}, rejectionReason = "") {
    const state = current.built.ctx.state || {};
    const actor = state.units?.[action.unit] || null;
    const rawDestination = action.destination || action.path?.at(-1) || "";
    let destination = "";
    try { if (rawDestination) destination = RulesEngine.normalizeHex(rawDestination); }
    catch {}
    const supplySensitive = /supply|补给|isolat/i.test(String(rejectionReason || ""));
    const relevant = Object.entries(state.units || {}).filter(([id, unit]) => {
      if (id === action.unit) return true;
      if (supplySensitive && unit.side === current.side
        && (RulesEngine.isSupplyUnit({ id, ...unit }) || RulesEngine.isCombatUnit({ id, ...unit }))) return true;
      if (!unit.hex) return false;
      try {
        return (actor?.hex && RulesEngine.hexDistance(actor.hex, unit.hex) <= 4)
          || (destination && RulesEngine.hexDistance(destination, unit.hex) <= 4);
      }
      catch { return false; }
    });
    const units = relevant.sort(([left], [right]) => left.localeCompare(right)).map(([id, unit]) => [id, {
      hex: unit.hex || "",
      state: unit.state || "",
      eliminated: !!unit.eliminated,
      isolated: !!unit.isolated,
      attacked_this_turn: !!unit.attacked_this_turn,
      attacked_this_phase: !!unit.attacked_this_phase
    }]);
    return crypto.createHash("sha256").update(JSON.stringify({
      phase: state.phase,
      active_side: state.active_side,
      units
    })).digest("hex");
  }

  function viewMap(args = {}) {
    const focus = args.focus || "overview";
    if (!["overview", "frontline", "region", "unit", "hex"].includes(focus)) {
      return { ok: false, read_only: true, reason: `unknown map focus ${focus}` };
    }
    const target = String(args.target || "");
    if (["unit", "hex", "region"].includes(focus) && !target) {
      return { ok: false, read_only: true, reason: `view_map focus=${focus} requires target` };
    }
    const publicContext = current.built.publicContext;
    const units = actionableUnits();
    const base = {
      ok: true,
      read_only: true,
      focus,
      snapshot: {
        step: current.step,
        turn: current.turn,
        phase: current.phase,
        side: current.side
      },
      objectives: clone(publicContext.objectives),
      current_phase_allowed_actions: clone(publicContext.protocol?.current_phase_allowed_actions || []),
      actionable_units: units,
      recent_rule_rejections: recentRuleRejections()
    };
    if (focus === "unit") {
      const detail = inspect({ kind: "unit", target });
      if (!detail.legal) return { ...base, ok: false, reason: detail.reason };
      return { ...base, unit: detail.unit, hex: inspect({ kind: "hex", target: detail.unit.hex }) };
    }
    if (focus === "hex") {
      const detail = inspect({ kind: "hex", target });
      if (!detail.legal) return { ...base, ok: false, reason: detail.reason };
      return { ...base, hex: detail, topology: { neighbors: detail.neighbors || [] } };
    }
    if (focus === "region") {
      try {
        const radius = Math.min(4, Math.max(1, Number(args.radius || 2)));
        const hexes = mapRegionHexes(current.built.ctx, target, radius);
        return {
          ...base,
          region: {
            center: RulesEngine.normalizeHex(target),
            radius,
            hexes: hexes.map((hex) => mapHexState(current.built.ctx, hex, current.side)),
            connections: renderConnectionMap(current.built.ctx, hexes)
          }
        };
      }
      catch (error) {
        return { ...base, ok: false, reason: error.message };
      }
    }
    const minefields = current.built.allUnits
      .filter((unit) => unit.kind === "mine" && unit.hex && !unit.eliminated && !unit.cleared)
      .map((unit) => ({ id: unit.id, side: unit.side, hex: unit.hex }));
    if (focus === "frontline") {
      return {
        ...base,
        frontline: clone(publicContext.map_intel?.frontline || []),
        combat_contacts: combatContacts(units),
        minefields
      };
    }
    return {
      ...base,
      game: clone(publicContext.game),
      unit_index: clone(publicContext.unit_index),
      battlefield_summary: clone(publicContext.battlefield_summary),
      map_intel: clone(publicContext.map_intel),
      map_topology: clone(publicContext.map_topology),
      combat_contacts: combatContacts(units),
      minefields
    };
  }

  function checkExitWest(action = {}) {
    const state = current.built.ctx.state;
    const unit = state.units?.[action.unit];
    if (!unit) return { legal: false, reason: "unknown unit", action };
    if (state.scenario !== "october") return { legal: false, reason: "exit_west is only legal in October", action };
    if (state.active_side !== "axis" || unit.side !== "axis") return { legal: false, reason: "exit_west is only legal for the active Axis side", action };
    if (!["initial_movement", "mechanized_movement", "supply_movement"].includes(String(state.phase || "").replace(/^(axis|allies)_/, ""))) {
      return { legal: false, reason: "exit_west is only legal in an Axis movement phase", action };
    }
    if (Number(state.turn || 1) <= 10) return { legal: false, reason: "exit_west is legal after turn 10 only", action };
    if (!unit.hex) return { legal: false, reason: "unit is not on the map", action };
    try {
      if (RulesEngine.splitHex(unit.hex)[0] !== 1) return { legal: false, reason: "exit_west requires a west-edge unit", action };
    }
    catch (error) {
      return { legal: false, reason: error.message, action };
    }
    if (!(RulesEngine.isCombatUnit({ id: action.unit, ...unit }) || RulesEngine.isSupplyUnit({ id: action.unit, ...unit }))) {
      return { legal: false, reason: "exit_west requires a combat or supply unit", action };
    }
    return { legal: true, reason: "exit west", action: { type: "exit_west", unit: action.unit } };
  }

  function assessAction(action = {}) {
    if (action.type === "exit_west") return checkExitWest(action);
    return evaluateProbeAction(current.evaluationContext, action, current.built.ctx);
  }

  function reviewForExecution(action = {}) {
    const assessment = assessAction(action);
    const canonicalAction = assessment.action || action;
    const review = finalActionReview(current.evaluationContext, action, assessment);
    const movementReview = reviewStrategicMovement({
      decisionMode: current.decisionMode,
      action: canonicalAction,
      assessment,
      operationState: current.operationState,
      history: movementHistory.get(canonicalAction.unit) || [],
      state: current.built.ctx.state,
      ctx: current.built.ctx
    });
    const taskDispatchReview = reviewTaskDispatch({
      decisionMode: current.decisionMode,
      action: canonicalAction,
      assessment,
      operationState: current.operationState,
      candidates: current.evaluationContext.candidate_actions || [],
      state: current.built.ctx.state
    });
    const combatReview = reviewStrategicCombat({
      decisionMode: current.decisionMode,
      action: canonicalAction,
      assessment,
      operationState: current.operationState,
      candidates: current.evaluationContext.candidate_actions || [],
      state: current.built.ctx.state
    });
    return {
      assessment,
      review,
      canonicalAction,
      strategicReview: {
        accept: movementReview.accept && combatReview.accept && taskDispatchReview.accept,
        issues: [...movementReview.issues, ...combatReview.issues, ...taskDispatchReview.issues],
        warnings: [...(movementReview.warnings || []), ...(combatReview.warnings || []), ...(taskDispatchReview.warnings || [])],
        alternatives: [...(movementReview.alternatives || []), ...(combatReview.alternatives || [])].slice(0, 3),
        exemptions: [...movementReview.exemptions, ...combatReview.exemptions, ...taskDispatchReview.exemptions]
      }
    };
  }

  function recordAcceptedMovement(action = {}) {
    if (action.type !== "move" || !action.unit) return;
    const start = current.built.ctx.state.units?.[action.unit]?.hex || "";
    const destination = RulesEngine.normalizeHex(action.destination || action.path?.at(-1) || "");
    const history = movementHistory.get(action.unit) || [];
    if (start && history.at(-1) !== start) history.push(start);
    if (destination && history.at(-1) !== destination) history.push(destination);
    movementHistory.set(action.unit, history.slice(-4));
  }

  function evaluate(args = {}) {
    const action = args.action || {};
    const assessment = assessAction(action);
    const review = finalActionReview(current.evaluationContext, action, assessment);
    if (!assessment.legal || !review.accept) {
      return { legal: false, accepted: false, retryable: true, reason: assessment.reason, issues: review.issues || [], assessment };
    }
    const proposalId = `${current.step}-${crypto.randomBytes(12).toString("base64url")}`;
    current.proposals.set(proposalId, clone(assessment.action || action));
    return {
      legal: true,
      accepted: true,
      proposal_id: proposalId,
      canonical_action: clone(assessment.action || action),
      assessment
    };
  }

  function submit(args = {}) {
    if (current.submitted) return { accepted: false, reason: "an action was already accepted for this step" };
    const proposalId = String(args.proposal_id || "");
    if (!proposalId.startsWith(`${current.step}-`) || !current.proposals.has(proposalId)) {
      return { accepted: false, reason: "proposal_id is missing, stale, or was not accepted by evaluate_action" };
    }
    current.submitted = clone(current.proposals.get(proposalId));
    recordAcceptedMovement(current.submitted);
    current.accepted_at_record = records.length;
    return { accepted: true, stop: true, action: clone(current.submitted), instruction: "Action accepted. Stop calling tools." };
  }

  function act(args = {}) {
    if (current.submitted) return { accepted: false, retryable: false, stop: true, reason: "an action was already accepted for this step" };
    const action = args.action || {};
    const memoryKey = `${current.session_id}:${current.side}:${current.phase}:${actionSignature(action)}`;
    const priorRejection = rejectionMemory.get(memoryKey);
    const stateFingerprint = relevantStateFingerprint(action, priorRejection?.reason || "");
    if (priorRejection?.state_fingerprint === stateFingerprint) {
      return {
        accepted: false,
        retryable: false,
        stop: true,
        reason: `unchanged_state_repeat: this exact action was already rejected: ${priorRejection.reason}`,
        rejection_type: priorRejection.rejection_type || "rules",
        repeated_rejection_count: Number(priorRejection.count || 1) + 1,
        recommended_recovery: "Choose a different action. Reconsider this proposal only after a relevant unit position, supply network, combat state, or phase changes."
      };
    }
    if (hasHoldTool) {
      const status = phaseStatus();
      const movementPhase = ["initial_movement", "mechanized_movement", "supply_movement"]
        .includes(status.snapshot?.phase_kind);
      if (action.type === "pass" && movementPhase && !status.can_pass) {
        return {
          accepted: false,
          retryable: true,
          stop: false,
          reason: `cannot pass while ${status.remaining_units.length} eligible unit(s) remain or mandatory repairs are unresolved`,
          phase_status: status
        };
      }
      if (action.unit && status.held_units.includes(action.unit)) {
        return { accepted: false, retryable: true, stop: false, reason: `${action.unit} is already held for this phase`, phase_status: status };
      }
    }
    const assessment = assessAction(action);
    const review = finalActionReview(current.evaluationContext, action, assessment);
    const canonicalAction = assessment.action || action;
    const movementReview = reviewStrategicMovement({
      decisionMode: current.decisionMode,
      action: canonicalAction,
      assessment,
      operationState: current.operationState,
      history: movementHistory.get(canonicalAction.unit) || [],
      state: current.built.ctx.state,
      ctx: current.built.ctx
    });
    const combatReview = reviewStrategicCombat({
      decisionMode: current.decisionMode,
      action: canonicalAction,
      assessment,
      operationState: current.operationState,
      candidates: current.evaluationContext.candidate_actions || [],
      state: current.built.ctx.state
    });
    const taskDispatchReview = reviewTaskDispatch({
      decisionMode: current.decisionMode,
      action: canonicalAction,
      assessment,
      operationState: current.operationState,
      candidates: current.evaluationContext.candidate_actions || []
    });
    const strategicReview = {
      accept: movementReview.accept && combatReview.accept && taskDispatchReview.accept,
      issues: [...movementReview.issues, ...combatReview.issues, ...taskDispatchReview.issues],
      warnings: [...(movementReview.warnings || []), ...(combatReview.warnings || []), ...(taskDispatchReview.warnings || [])],
      alternatives: [...(movementReview.alternatives || []), ...(combatReview.alternatives || [])].slice(0, 3),
      exemptions: [...movementReview.exemptions, ...combatReview.exemptions, ...taskDispatchReview.exemptions]
    };
    const passStatus = action.type === "pass" && hasHoldTool ? phaseStatus() : null;
    const rollingPassAllowed = action.type === "pass"
      && hasHoldTool
      && ["initial_movement", "mechanized_movement", "supply_movement"].includes(passStatus?.snapshot?.phase_kind)
      && passStatus.can_pass;
    if (!assessment.legal || ((!review.accept || !strategicReview.accept) && !rollingPassAllowed)) {
      const reason = review.issues?.[0] || strategicReview.issues[0] || assessment.reason || "action is not accepted";
      const rejectionSignature = JSON.stringify([canonicalAction, reason]);
      const rejectionCount = (current.rejection_counts.get(rejectionSignature) || 0) + 1;
      current.rejection_counts.set(rejectionSignature, rejectionCount);
      const retryable = rejectionCount < 2;
      rejectionMemory.set(memoryKey, {
        state_fingerprint: relevantStateFingerprint(canonicalAction, reason),
        reason,
        rejection_type: assessment.legal ? "strategy" : "rules",
        count: Number(priorRejection?.count || 0) + 1,
        step: current.step
      });
      const alternatives = [
        ...(strategicReview.alternatives || []),
        ...(strategicReview.accept ? assessment.alternatives || [] : [])
      ].filter((item, index, values) => values.findIndex((candidate) => JSON.stringify(candidate.action || candidate) === JSON.stringify(item.action || item)) === index)
        .slice(0, 3);
      return {
        accepted: false,
        retryable,
        stop: !retryable,
        reason,
        rejection_type: assessment.legal ? "strategy" : "rules",
        repeated_rejection_count: rejectionCount,
        issues: [...(review.issues || []), ...strategicReview.issues],
        alternatives,
        recommended_recovery: !strategicReview.accept && canonicalAction.type === "combat" && alternatives.length === 0
          ? "No listed combat meets the strategic minimum; submit pass to end combat or use check_combat on a different combined subset."
          : assessment.recommended_recovery || recoveryGuidance({ reason, assessment, strategicReview }),
        strategic_review: strategicReview,
        assessment
      };
    }
    current.submitted = clone(canonicalAction);
    recordAcceptedMovement(current.submitted);
    current.accepted_at_record = records.length;
    return {
      accepted: true,
      stop: true,
      action: clone(current.submitted),
      canonical_action: clone(current.submitted),
      assessment,
      strategic_review: strategicReview,
      instruction: "Action accepted. Stop calling tools."
    };
  }

  function executeTool(tool, args = {}, sessionId = "") {
    assertCurrent(sessionId);
    if (!profile.tools.includes(tool)) throw new Error(`tool ${tool} is not enabled by profile ${profile.id}`);
    if (current.tool_calls >= profile.max_calls_per_step) {
      return { accepted: false, retryable: false, stop: true, reason: `tool call limit ${profile.max_calls_per_step} reached` };
    }
    const started = Date.now();
    const readOnly = new Set(["phase_status", "view_map", "inspect_rules", "inspect_supply", "check_combat", "inspect", "plan_route", "evaluate_maneuver"]);
    const cacheKey = readOnly.has(tool) ? `${tool}:${JSON.stringify(args || {})}` : "";
    if (current.submitted) {
      const result = { accepted: false, retryable: false, stop: true, reason: "an action was already accepted for this step" };
      current.tool_calls += 1;
      records.push({ step: current.step, turn: current.turn, phase: current.phase, session_id: sessionId, tool, arguments: clone(args), result, elapsed_ms: Date.now() - started, after_submission: true });
      return result;
    }
    if (cacheKey && current.read_only_cache.has(cacheKey)) {
      const duplicateCount = Number(current.duplicate_read_only_calls.get(cacheKey) || 0) + 1;
      current.duplicate_read_only_calls.set(cacheKey, duplicateCount);
      const result = {
        ...clone(current.read_only_cache.get(cacheKey)),
        cached: true,
        control: {
          force_action: true,
          duplicate_read_only_call: duplicateCount,
          message: "This exact read-only query was already answered in this step. Use the cached result and call act now."
        }
      };
      current.tool_calls += 1;
      records.push({ step: current.step, turn: current.turn, phase: current.phase, session_id: sessionId, tool, arguments: clone(args), result: clone(result), elapsed_ms: Date.now() - started, cached: true, after_submission: false });
      return result;
    }
    let result;
    if (current.submitted) {
      result = { accepted: false, retryable: false, stop: true, reason: "an action was already accepted for this step" };
    }
    else if (tool === "view_map") result = viewMap(args);
    else if (tool === "plan_route" || tool === "evaluate_maneuver") result = runTool(
      { ctx: current.built.ctx, allUnits: current.built.allUnits },
      current.built.publicContext,
      tool,
      args
    );
    else if (tool === "inspect_rules") result = runTool(
      { ctx: current.built.ctx, allUnits: current.built.allUnits },
      current.built.publicContext,
      "inspect_rules",
      { topic: args.topic }
    );
    else if (tool === "check_combat") {
      result = runTool(
        { ctx: current.built.ctx, allUnits: current.built.allUnits },
        current.built.publicContext,
        "check_combat",
        { attackers: args.attackers, defender_hexes: args.defender_hexes }
      );
    }
    else if (tool === "inspect_supply") {
      result = runTool(
        { ctx: current.built.ctx, allUnits: current.built.allUnits },
        current.built.publicContext,
        "trace_supply",
        { unit: args.unit }
      );
    }
    else if (tool === "phase_status") result = phaseStatus();
    else if (tool === "hold_unit") result = holdUnit(args);
    else if (tool === "hold_units") result = holdUnits(args);
    else if (tool === "act") result = act(args);
    else if (tool === "inspect") result = inspect(args);
    else if (tool === "evaluate_action") result = evaluate(args);
    else if (tool === "submit_action") result = submit(args);
    else result = { accepted: false, reason: `unknown bridge tool ${tool}` };
    if (cacheKey && result && result.read_only) current.read_only_cache.set(cacheKey, clone(result));
    current.tool_calls += 1;
    records.push({
      step: current.step,
      turn: current.turn,
      phase: current.phase,
      session_id: sessionId,
      tool,
      arguments: clone(args),
      result: clone(result),
      elapsed_ms: Date.now() - started,
      after_submission: current.accepted_at_record >= 0 && records.length > current.accepted_at_record
    });
    return result;
  }

  async function handle(req, res) {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, tool_profile: profile.id }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/tool") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid bridge token" }));
      return;
    }
    try {
      const body = await readBody(req);
      const result = executeTool(body.tool, body.arguments || {}, body.session_id || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    }
    catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  async function start() {
    if (server) return api;
    server = http.createServer(handle);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${server.address().port}`;
    return api;
  }

  async function close() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }

  const api = {
    token,
    profile,
    records,
    executeTool,
    prepareStep,
    phaseStatus: () => current ? clone(phaseStatus()) : null,
    submittedAction: () => current?.submitted ? clone(current.submitted) : null,
    fallbackAction,
    current: () => current,
    start,
    close,
    get url() { return url; }
  };
  return api;
}

module.exports = { createActionRuleBridge, reviewStrategicMovement, reviewStrategicCombat, reviewTaskDispatch };
