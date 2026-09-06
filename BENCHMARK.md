# Alamein Agent Benchmark

The benchmark evaluates external Agent methods against the same complex rules AI
in the same game environment. It does not change the published game rules.
The three Harness implementations are independent direct baselines. The
project's own decision policies use the `manual_single_action` runner and its
SAE/task runtime; a baseline Harness is never labeled as having executed SAE.

## Quick start

```bash
pnpm install
uv sync --locked --group dev
pnpm test
```

The default model is the offline `mock_primary` profile. A real model is opt-in:

```bash
pnpm run ai:full-game -- --scenario july --external-side axis \
  --decision-policy hierarchical_sae --model-profile deepseek_flash --seed 1942
```

## Fair comparison

For a strict method comparison, keep the model, Harness, tools, context, prompt,
budget, timeout, opponent controller, scenario, side, and artifact manifest
fixed. Only change the decision policy. For a Harness comparison, use the
`direct` policy and change only the independent Harness. For a model comparison,
keep the Harness and decision policy fixed and change only the model profile.
To compare the complete systems, use `--systems` and report that tools, task
management, or context may differ; this is a system-capability comparison, not
a pure method ablation.

Run validation before reporting a ranking:

```bash
pnpm run ai:compare -- --dimension method log/run-a.json log/run-b.json
```

The validator rejects missing artifact manifests, mismatched conditions,
incomplete or failed runs, and incomplete seed/replicate pairs. A completed
run remains ranking-eligible when the declared method fallback handled a model
or transport failure; infrastructure status and fallback counts remain visible
in the report. The validator also emits paired
results aligned by `seed + replicate`, including the compared VP difference.
Use `--baseline` to choose the reference variant; otherwise it prefers
`direct` for method comparisons and `manual_single_action` for Harness
comparisons:

```bash
pnpm run ai:compare -- --dimension method --baseline direct \
  log/direct-1942-r1.json log/hybrid-1942-r1.json
```

The batch runner rejects unsupported combinations before starting a run. For
example, `opencode_harness + hierarchical_sae` is invalid because OpenCode is
the direct baseline, while the following selects the project's own runtime:

```bash
pnpm run ai:batch -- --systems hierarchical_sae --model-profile mock_primary \
  --scenario july --external-side axis --seed 1942
```

Raw logs remain available for diagnosis. A completed infrastructure-affected
run may be ranked because its declared fallback is part of end-to-end method
behavior. A pair containing an incomplete, failed, missing-artifact, or
duplicate run keeps its raw VP, but its formal `vp_difference` is `null`.

## Model and tool extension

Add a model profile to `ai/config/ai_models.yaml` and a tool combination to the
YAML tool profiles. Harnesses must access models through the shared runtime and
must submit game actions through the shared rule bridge. API keys belong only in
environment variables.

Generated experiment records belong in `log/`, which is intentionally ignored by
Git. Do not publish raw real-model transcripts without a separate redaction and
privacy review.
