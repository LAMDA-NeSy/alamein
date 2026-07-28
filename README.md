# Alamein Judge Studio

Browser-based judge and AI workspace for the three El Alamein scenarios:

- July 1942: First Battle of El Alamein
- September 1942: Alam el Halfa
- October 1942: Second Battle of El Alamein

The project provides a map interface, scenario setup, rule validation, combat resolution, retreat planning, supply checks, AI controls, replay tools, and a player-facing rule source.

## Run Locally

From the project directory:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/) in a browser.

The app is a static browser application. It does not require a build step or a database.

## Authoritative Rules

The only authoritative rule source is:

`docs/el_alamein_rules_cn_translation.md`

The player rule page at `rules.html` displays that source directly. `rules_el_alamein.json` is the runtime projection used by the judge and AI; it is not an independent rulebook.

## Project Areas

- `app.js`: browser UI, map interactions, combat workflow, AI playback, and state management.
- `rule_engine.js`: dependency-free rule decisions shared by the browser and Node tests.
- `rules_el_alamein.json`: runtime rule configuration derived from the authoritative translation.
- `terrain.json`: map terrain, coast, road, and edge data.
- `scenarios/`: July, September, and October scenario states.
- `docs/`: authoritative rules and project progress documents.
- `mod_images/`: counter and interface artwork used by the web app.
- `rule_engine.test.js`: rule-engine regression tests.

## Validation

Run the available tests with the bundled Node runtime or a local Node.js installation:

```bash
node --test rule_engine.test.js external_ai_transcript.test.js
```

The test suite covers stacking limits, engineer handling, movement, supply, combat, retreat priorities, temporary overstack repair, and elimination when repair is impossible.

## Scope

This repository contains the web judge and AI workspace only. Vassal modules, Vassal conversion tools, and `.vmod` assets are intentionally excluded.
