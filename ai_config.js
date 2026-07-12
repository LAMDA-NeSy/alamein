/*
 * Central AI configuration for Alamein Judge Studio.
 * Put non-secret model/provider defaults here. API keys should stay in the
 * in-app AI profile storage or a private local override, not in git history.
 */
(function configureAlameinAi(global) {
  const config = {
    provider: "deepseek",
    api: {
      kind: "chat_completions",
      url: "https://api.deepseek.com/chat/completions",
      localProxyUrl: "http://127.0.0.1:8787/chat/completions",
      model: "deepseek-v4-flash",
      apiKey: "",
      timeoutSeconds: 30,
      maxToolRounds: 4,
      temperature: 0.25,
      maxTokens: 3600,
      repairMaxTokens: 900,
      responseFormat: { type: "json_object" }
    },
    context: {
      maxLegalActions: 60,
      maxCandidateActions: 12,
      maxRecentLogItems: 8,
      maxToolResults: 6,
      maxUnitsPerSide: 40,
      maxUnitIndexPerSide: 160,
      maxMapIntelHexes: 16,
      maxFrontlineUnits: 10,
      maxNearbyEnemiesPerUnit: 3,
      maxNearbyEnemyDetailUnitsPerSide: 14,
      maxReachableHexesPerCandidateUnit: 50,
      includeFullStateSummary: false
    },
    strategy: {
      doctrine:
        "You are a game agent playing to win the current side's scenario victory, not a passive rules helper. Think in game terms first: victory conditions, tempo, supply, force preservation, positional pressure, and legal execution. Preserve legal tempo, keep supply open, prefer reversible information-gathering moves when the board is unclear, and never invent rules.",
      actionContract:
        "Return one tiny JSON object only. Use either {\"type\":\"tool_call\",\"tool\":\"...\",\"arguments\":{...}} or {\"type\":\"final_action\",\"reason\":\"...\",\"action\":{\"type\":\"move|combat|exit_west|pass\",...}}. Prefer candidate_actions; when choosing one, copy the action object exactly. Keep reason under 80 characters.",
      phaseObjectives: {
        initial_movement:
          "Improve position with legal fresh units. Axis should pressure Alamein and eastern routes; Allies should hold the box, preserve supply, and blunt exposed Axis units.",
        mechanized_movement:
          "Exploit with mobile units only when it improves threat, supply, or defensive geometry. Do not spend armor for tiny positional gains.",
        supply_movement:
          "Move supply assets to keep combat units connected, avoid enemy ZOC, and prepare next-turn operations.",
        combat:
          "Attack only when odds and expected CRT value justify spending attackers. Prefer attacks that disrupt supply, open routes, or protect a victory hex.",
        end_game_turn:
          "Evaluate victory and pass unless a legal end-turn operation is explicitly available."
      },
      priorities: [
        "Legal action first: every final action must pass the front-end validator.",
        "Never return an action that a recent evaluate_action tool result marked illegal.",
        "After a useful tool result, prefer final_action over more tool calls.",
        "Supply and isolation matter more than raw distance.",
        "Do not attack below useful odds unless it creates a decisive positional swing.",
        "Avoid entering enemy ZOC with supply or fragile units unless the move is clearly necessary.",
        "If uncertain, call a tool before returning a final action."
      ]
    }
  };

  global.ALAMEIN_AI_CONFIG = Object.freeze(config);
})(globalThis);
