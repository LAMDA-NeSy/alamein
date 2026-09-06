# Contributing

## Rules and benchmark versions

Do not silently change the rules, terrain, scenario setup, or scoring logic in an
existing benchmark version. A rules change requires a new benchmark version and
new reproducibility results. Changes to the Agent layer, Harness, model adapter,
tools, logging, or metrics should include focused tests.

## Local validation

```bash
pnpm install
uv sync --locked --group dev
pnpm test
uv run --locked --group dev pytest ai/tests
```

The default model is `mock_primary`, so tests do not need an API key. Never
commit `.env`, API keys, real request transcripts, or generated `log/` files.

## Comparison requirements

Benchmark claims must state the scenario, side, seed set, replicate count,
opponent controller, model profile, tool profile, Harness, prompt version, and
benchmark artifact manifest. Use `pnpm run ai:compare` before reporting a ranking.
