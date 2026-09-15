"use strict";

const { fingerprint } = require("./phase_execution_ledger.js");

function createGoalRevisionLedger(evaluate) {
  const revisions = [];
  let fixedEvaluation = null;
  const goalConditions = (goal) => ({ subject_side: goal?.subject_side, metric: goal?.metric,
    relation: goal?.relation, target: goal?.target, target_column: goal?.target_column,
    target_vp: goal?.target_vp, target_hex: goal?.target_hex,
    observable_conditions: goal?.observable_conditions, evaluation_scope: goal?.evaluation_scope,
    campaign_goal: goal?.campaign_goal ? goalConditions(goal.campaign_goal) : null });
  return {
    revise(goal, { input, plan, rulesEvaluation, reason }) {
      if (!goal) return null;
      if (!fixedEvaluation) fixedEvaluation = structuredClone(rulesEvaluation || {});
      const previous = revisions.at(-1);
      if (previous && fingerprint(goalConditions(previous.goal)) === fingerprint(goalConditions(goal))) return previous.goal_revision;
      const assessment = previous ? evaluate({ ...plan, side: input.side, children: [] }, input, previous.goal) : null;
      revisions.push({ goal_revision: revisions.length + 1, previous_revision: previous?.goal_revision || null,
        step: input.step, turn: input.turn, phase: input.phase,
        goal: structuredClone(goal), previous_goal: previous ? structuredClone(previous.goal) : null,
        previous_completion: assessment, rule_facts: structuredClone(rulesEvaluation || {}),
        reason: String(goal.reason || goal.rationale || reason || "model_changed_operational_goal"),
        conditions_changed: previous ? { before: goalConditions(previous.goal), after: goalConditions(goal) } : null });
      return revisions.length;
    },
    report(input, plan) {
      return { protocol: "goal-revision-ledger-v1", fixed_game_evaluation: structuredClone(fixedEvaluation),
        opening_goal: structuredClone(revisions[0]?.goal || null), current_goal: structuredClone(revisions.at(-1)?.goal || null),
        revisions: structuredClone(revisions),
        evaluations: revisions.map((revision) => ({ goal_revision: revision.goal_revision,
          ...evaluate({ ...plan, side: input.side, children: [] }, input, revision.goal) })) };
    },
    clear() { revisions.length = 0; fixedEvaluation = null; }
  };
}

module.exports = { createGoalRevisionLedger };
