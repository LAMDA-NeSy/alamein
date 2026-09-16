# Task Acceptance And Request Accounting

The SAE comparison contract is `single-action-comparison-v19-typed-task-settlement`.
The configured task protocol is `side-aware-task-v4`. Rules, scoring, map data and
the Rules AI opponent are unchanged. Do not rank older runs with this contract.

## Typed Conditions

- `unit_survival`, `unit_supply`, `supply_coverage`, `position`: fractions in [0, 1].
- `surviving_unit_count`, `supplied_unit_count`, `units_at_target`: integer counts.
- `target_distance`: hex distance; `aggregation: max` checks all selected units,
  while `min` checks the nearest selected unit.
- `position` can select a `target_hex`, `target_region.hexes`, or an integer
  `target_region.column`. It measures occupancy, not distance or route denial.
- Invalid targets, unknown metrics and unavailable observations remain unknown.
  In `any`, a valid satisfied alternative can still establish the condition.

Every model-defined task declares `acceptance_contract.obligations`. Each
obligation contains a description and references completion condition IDs via
`condition_ids`. Structured target locations and settlement scope are checked.
Missing contracts remain unverified; the next ordinary strategic request carries
the original predicates and validation errors. No extra repair request is added.

`acceptance_contract.evaluation_scope` is `immediate`, `turn_end` or `game_end`.
Conditions may not settle earlier than the task promise. `mode: at_settlement`
requires the condition at that boundary; `mode: maintain` also retains observed
breaches before settlement. Maintenance evidence is limited to observed states,
not a proof about unobserved intermediate states.

The replay notifies both external providers at each actual end-of-turn boundary.
`task_turn_settlements` records deduplicated event IDs, state hashes and task
snapshots. Final scoring uses `final_task_settlement`, not the opening task plan.

The local validator does not prove that arbitrary prose is semantically equivalent
to its predicates. Models must map every promise explicitly; unknown strategic
effects must not be presented as verified outcomes.

## Replanning And Execution

Before plan reuse, SAE refreshes current evidence. A changed October withdrawal
window or breached goal constraint generates a deduplicated strategic event.
Critical task failure, repeated supply deterioration and evidenced no-progress
can also request replanning. The model still chooses the replacement goal.

Failed routes include current phase, origin, target occupants, rule diagnostics
and search limitations. Batch repairs receive this evidence and preceding executed
orders. A suggested destination is never a guarantee after other units move.

Combat inspection exposes the actual CRT distribution and first-step attacker
retreat options. Later contexts retain six recent actual combat outcomes. Risk
information does not prohibit a rule-legal model decision or bind an attacker set.

## Request Accounting

Client and gateway share one request ID. Local delivery failure is recorded even
when no upstream request record exists. Ambiguous delivery is not automatically
resent, avoiding duplicate paid requests; existing upstream retry policy remains.

Protocol failures are recorded separately from transport failures. Reused fallback
plans may affect many actions but do not create extra failed request counts.
Per-stage token fields survive credential redaction. Missing historical usage is
`null`; partial totals include `usage_coverage`, never an implied zero cost.

Historical logs are not overwritten. Redacted usage or missing observations cannot
be reconstructed as exact values. End-to-end method fallback results remain
available; infrastructure-affected results are separated from clean statistics.
