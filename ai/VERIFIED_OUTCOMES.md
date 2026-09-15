# Verified Outcomes (v18)

This revision changes the agent and evaluation implementation, not the game rules,
map, scoring, or complex Rules AI. Contracts use
`single-action-comparison-v18-verified-outcomes`; reports use metrics v5.

## Integrity And Comparisons

Historical artifact manifests are checked for internal consistency independently
of the current checkout. `reproducibility.matches_workspace` and `drift` describe
whether the current files still reproduce that snapshot. A hash is an integrity
check, not a signature proving who produced the log. Archive the exact source
checkout and environment with published results, including uncommitted changes.

Artifacts have separate rule, opponent, and implementation hashes. Formal method
comparisons still require compatible full contracts. Baseline pairing requires
matching rules and opponent hashes, scenario, seed, and replicate. A Rules-vs-Rules
game can be a reference for either external side; duplicate references are rejected.
An implementation change does not upgrade historical experiments to v18.

## Run Offline Validation

```bash
pnpm test
uv run --locked --group dev pytest ai/tests
pnpm run ai:acceptance -- --out-dir log/v18_mock \
  --model-profile mock_primary --task-checker-model-profile mock_secondary
pnpm run ai:baselines -- --out-dir log/v18_baselines --seed 1942 --replicate 1
```

Mock games run in parallel by default. The baseline command runs three
Rules-vs-Rules games serially and makes no model requests. Both commands require
new output directories. No paid model, Judge, or ordinary API failover is implicit.
Acceptance also requires a valid serialized artifact manifest, a closed phase
ledger, and at most one repair per unit and one repair request per phase. A normal
process exit alone is not acceptance evidence.

## Recompute A Report

```bash
pnpm run ai:metrics -- log/v18_mock/july_run.json \
  --baseline log/v18_baselines/july.json --out log/v18_report.json
pnpm run ai:metrics -- log/old_run.json \
  --recalculate --out log/old_run_recomputed_v5.json
```

Replace the example run filename with the generated transcript path; multiple
transcripts and repeated `--baseline` arguments are supported. Source transcripts
are never overwritten. Recomputed reports record source paths and contract hashes.
Historical baseline matches require the historical rule and opponent versions;
a current-code reference cannot silently substitute for them.

## Metric Semantics

- Allocation corrections are counted once per allocation version, not once per
  action using that allocation. Events retain allocation and correction IDs.
- Whole-game action rates combine movement-plan submissions and combat tool
  submissions, deduplicated by event ID. A movement-only ledger fallback is
  labelled explicitly; local actions do not enter the model rejection denominator.
- Task criteria are independent of task names and executor roles. Beneficiary
  units are evaluated separately. `all` requires every condition; `any` requires
  at least one. Current satisfaction and settlement time are separate facts.
- A child task is not failed merely because its parent failed. Missing terminal
  evidence is marked unverified. Task revisions retain separate results.
- Opportunity outcomes are effective, ineffective, or unknown. Overall conversion
  is unavailable when executed opportunities have unknown effects. The known-only
  rate is accompanied by evidence coverage and is not an unbiased overall estimate.
- Client request latency includes local scheduling. Long event-loop pauses are
  suspected environment effects, not confirmed computer sleep or server reasoning.
  Expired responses are retained for audit but cannot execute actions.
- A failed strategic revision retains the existing operation and allocations.
  It does not repeatedly request a revision in the same phase; a pending update
  remains visible and can be retried at the next phase.
- Clearance success rates require per-action evidence for the same acting side.
  Global Axis mine VP is reported separately. A rejected October line crossing
  still counts if a later action in that decision step succeeds.
- Method fallback remains part of end-to-end results. Clean performance and
  infrastructure-affected outcomes are reported separately.

Use matched multi-seed, multi-replicate experiments for paper claims. Single games
and Mock scores are diagnostics, not evidence of statistically significant gains.
