# SAE Execution Ledger

Comparison contract: `single-action-comparison-v16-execution-ledger`.

## Scope

The new execution path is enabled only by `hierarchical_sae.execution_ledger`.
Game rules, map connectivity, VP, scenarios and the complex rules controller are
unchanged. Other methods retain their existing execution policies.

## Movement Execution

- A phase ledger owns eligibility, terminal units, repair allowances and all plan
  versions. Routine task progress does not replace a plan. A changed goal or a lost
  key unit may replace outstanding commands, never already handled units.
- The model's existing 20-tool-call budget excludes local validation and hold
  bookkeeping. The shared bridge still accepts at most one game action per step.
- Invalid orders wait while other valid orders execute. One concentrated repair
  request may address the failed units, with up to five currently legal suggestions
  per unit. Its deadline is at most 30 seconds and never exceeds the step deadline.
- A unit may be repaired once per phase, including across plan replacements.
  A successful repair may explicitly hold. Protocol/transport/repair failures can
  fall back to a reasoned local hold. Mandatory stack repair cannot be held away.
- Legal holds require no rationale keywords. Rationale quality is a warning, not
  a rule. Local fallback considers verified scenario/task gains, not eastward
  displacement, and can preserve units when no gain is verified.
- Route suggestions are bounded searches. Their paths, cost, supply and searched
  scope are exposed; not finding a path is not proof of global unreachability.

## Goals And Feedback

`goal-revision-ledger-v1` retains the opening goal, fixed opening evaluation,
current goal, revision reasons, earlier completion evidence and final evaluations
of every goal revision, including the campaign goal. Model goal changes never
change game scoring or the rules-based final result.

Execution events are assigned to individual tasks. Two evidenced tactical
failures with no remaining executable order can block that task. Budget, deadline
and transport failures are not tactical failures; a hold is not automatically
stagnation. Other independent tasks may continue. New phases revalidate blocked
tasks while retaining their history. Full older task plans are archived once,
not recursively repeated in every new observation.

SAE task snapshots carry the latest eight execution events and a cumulative
`execution_history_summary`. Full events remain in the task manager, per-step
execution ledger and final settlement's `task_execution_history`; archived plans
retain the earlier tasks. Snapshot compression does not reset repair/failure
counters or discard audit history. Other methods keep their existing snapshots.

Transcript checkpoints are written atomically in record-sized JSON chunks.
Acceptance and metrics readers stream large files instead of constructing one
V8 string for the whole transcript. The on-disk format remains ordinary JSON.

Checker calls have an event cooldown and a per-turn cap. Checker judgments cannot
settle game-end conditions early or modify game state. JSON-only planning requests
explicitly have no callable tools. Raw outputs and references to unavailable
capabilities are retained for diagnosis.

## Provenance And Metrics

- Movement records contain `phase_id`, `plan_id`, `order_id`, `event_id` and
  `request_id`. Model-original and repaired commands remain distinguishable.
- `execution_ledger.events` contains step-local changes. Summary calculations
  deduplicate event IDs, not the last snapshot of each phase. All replaced plans
  remain in the version history.
- Model action rejection denominators exclude local commands and system phase
  endings. A validation stopped by deadline is not a rule-engine rejection.
- Request records identify strategic, allocation, unit-plan, concentrated-repair,
  checker and interactive execution stages. Request IDs link transport, retry,
  token and API timing records.
- Context generation, local act/path validation, controller computation and
  checkpoint writing are reported separately. Checkpoint write timing covers
  completed writes before the current checkpoint, explicitly labelled as such.
- Opportunities distinguish discovery, actual model exposure, model selection,
  execution and verified effect. A projected supply/route improvement is not a
  scored outcome. Missing effect evidence is `null`, not a success or failure.
- Legacy plan versions can be reconstructed offline from `plan_created` and
  snapshots. Missing IDs and command provenance remain missing. Reconstruction
  does not make old contracts comparable to v16.

## Acceptance Runs

Run tests, then six Mock games, then (only if every gate passes) the explicitly
selected real batch:

```bash
node ai/experiments/run_sae_validation.js \
  --out-dir log/sae_validation_new_batch \
  --real-model-profile glm_53_flash_coding_plan \
  --real-checker-profile glm_53_flash_checker
```

Without both real-profile flags this command runs offline validation only.
`validation_manifest.json` records the gate, subprocess IDs, exit codes and logs.
A failed test or Mock acceptance prevents all subsequent real requests.

Run a serial six-case Mock acceptance batch without credentials:

```bash
node ai/experiments/run_sae_acceptance.js \
  --out-dir log/sae_mock_new_batch \
  --model-profile mock_primary \
  --task-checker-model-profile mock_secondary
```

Run the explicitly authorized real batch:

```bash
node ai/experiments/run_sae_acceptance.js \
  --out-dir log/sae_real_new_batch \
  --model-profile glm_53_flash_coding_plan \
  --task-checker-model-profile glm_53_flash_checker
```

Order: July Axis, July Allies, September Axis, September Allies, October Axis,
October Allies. The seed is 1942, the opponent is `rules_ai`, the tool profile is
`rolling_unit_rules_tactical`, and the step deadline is 180 seconds. Step limits
remain 1000/1500/3000 respectively. An existing batch cannot be overwritten.
There is no ordinary-API failover and no automatic paid rerun.

The batch manifest records every child process and outcome. Completed runs require
a final victory flag, zero application-layer illegal actions, no context callback
errors and closed movement ledgers. The metrics command runs after the serial
batch and writes `all_scenarios_metrics.json`. Judge metrics are not silently
purchased; unrun Judge results remain missing. These single-seed runs diagnose
behavior and do not establish statistical improvement.
