"use strict";

const {
  buildContext,
  normalizePhaseIntent,
  publicPayload,
  systemPrompt
} = require("../experiments/external_ai_transcript.js");
const { compactAgentPayload, contextBytes } = require("./agent_context.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseModelJson(result) {
  const content = result?.response_json?.choices?.[0]?.message?.content || "";
  if (!content) return { error: "model returned empty phase intent" };
  try {
    return JSON.parse(content);
  }
  catch (error) {
    return { error: `invalid phase intent JSON: ${error.message}` };
  }
}

function hasHighPriorityAction(candidatePool, threshold = 120) {
  return candidatePool.some((item) => {
    const action = item.action || {};
    if (action.type === "pass") return false;
    const impact = item.evaluation?.victory_impact || {};
    const tags = item.evaluation?.tactical_tags || [];
    return Number(item.score || 0) >= threshold
      || impact.vp_relevance === "primary_objective"
      || impact.vp_relevance === "direct"
      || tags.includes("primary objective target");
  });
}

function phaseKey(input) {
  return `${Number(input.turn)}:${input.phase}:${input.side}`;
}

function createPhaseIntentPlanner({ config, runtime, client, decisionPolicy = "direct" }) {
  const cache = new Map();
  const strongActionScore = Number(config.context?.hybridFastPassStrongActionScore || 120);
  const planningPolicies = new Set(["hybrid", "opportunity_aware_hybrid", "unit_plan_hybrid", "strategy_execute"]);

  async function plan(input) {
    if (!planningPolicies.has(decisionPolicy)) return { phaseIntent: null, record: null, localFastPass: false };

    const key = phaseKey(input);
    const cached = cache.get(key);
    if (cached) {
      return {
        phaseIntent: clone(cached.phaseIntent),
        record: { ...clone(cached.record), cache_key: key, reused: true },
        localFastPass: cached.localFastPass
      };
    }

    // This local pool is never exposed to the intent request. It only prevents
    // an empty phase from consuming a model call and guards a model-requested pass.
    const built = buildContext(config, { state: input.state, decisionMode: decisionPolicy });
    const legalityBuilt = ["strategy_execute", "unit_plan_hybrid"].includes(decisionPolicy)
      ? buildContext(config, { state: input.state, decisionMode: "candidates" })
      : built;
    const candidatePool = legalityBuilt.candidatePool || [];
    const hasNonPass = candidatePool.some((item) => item.action?.type !== "pass");
    if (!hasNonPass) {
      const phaseIntent = normalizePhaseIntent({ type: "pass" }, input.state);
      const record = {
        source: "local_fast_pass",
        cache_key: key,
        reused: false,
        value: phaseIntent,
        candidate_pool_size: candidatePool.length,
        execution_candidate_count: 1,
        fallback_reason: "no legal non-pass action"
      };
      cache.set(key, { phaseIntent, record, localFastPass: true });
      return { phaseIntent: clone(phaseIntent), record: clone(record), localFastPass: true };
    }

    let result = null;
    let parsed = null;
    const strategyPayload = compactAgentPayload(publicPayload(config, built.publicContext, []));
    try {
      result = await client.complete({
        messages: [
          { role: "system", content: systemPrompt(config, "hybrid_intent", input.side) },
          { role: "user", content: JSON.stringify(strategyPayload) }
        ],
        temperature: runtime.profile.defaults.temperature,
        max_tokens: Math.min(Number(config.context?.phaseStrategyMaxTokens || 3000), runtime.profile.limits.output),
        response_format: runtime.profile.capabilities.structured_output ? { type: "json_object" } : undefined
      });
      parsed = result.ok ? parseModelJson(result) : { error: `model API status ${result.status}` };
    }
    catch (error) {
      parsed = { error: error.message };
    }

    const rawIntent = parsed?.type === "phase_intent" ? parsed.intent || parsed : parsed;
    const phaseIntent = normalizePhaseIntent(rawIntent, input.state);
    const highPriorityAction = hasHighPriorityAction(candidatePool, strongActionScore);
    // strategy_execute lets the executor submit pass through act so the model
    // remains responsible for every non-empty decision step.
    const localFastPass = ["hybrid", "opportunity_aware_hybrid"].includes(decisionPolicy)
      && phaseIntent.type === "pass" && !highPriorityAction;
    const record = {
      source: phaseIntent.source,
      cache_key: key,
      reused: false,
      value: phaseIntent,
      raw: parsed || null,
      api: {
        status: result?.status ?? null,
        elapsed_ms: result?.elapsed_ms ?? null,
        error: parsed?.error || result?.error || null
      },
      candidate_pool_size: candidatePool.length,
      strategy_context_bytes: contextBytes(strategyPayload),
      high_priority_action: highPriorityAction,
      execution_candidate_count: null,
      fallback_reason: phaseIntent.fallback_reason || parsed?.error || ""
    };
    cache.set(key, { phaseIntent, record, localFastPass });
    return { phaseIntent: clone(phaseIntent), record: clone(record), localFastPass };
  }

  function clear() {
    cache.clear();
  }

  return { cache, clear, plan };
}

module.exports = {
  createPhaseIntentPlanner,
  hasHighPriorityAction,
  parseModelJson,
  phaseKey
};
