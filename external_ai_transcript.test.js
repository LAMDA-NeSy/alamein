const test = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("./rule_engine.js");
const Transcript = require("./external_ai_transcript.js");

function combatContext() {
  const config = Transcript.readConfig();
  return Transcript.buildContext(config, {
    state: {
      scenario: "july",
      turn: 1,
      phase: "axis_combat",
      active_side: "axis",
      road_supply_markers: { axis: "2424" },
      scenario_meta: { road_path: ["0101", "2424"] },
      units: {
        attacker: { side: "axis", hex: "2424", state: "fresh", attack: 2, defense: 2, movement: 4, kind: "ground" },
        defender: { side: "allies", hex: "2524", state: "fresh", attack: 1, defense: 1, movement: 4, kind: "ground" }
      }
    }
  });
}

test("external AI unit intel reports the unit's actual ZOC", () => {
  const built = combatContext();
  const result = Transcript.runTool(
    { ctx: built.ctx, allUnits: built.allUnits },
    built.publicContext,
    "inspect_unit",
    { unit: "attacker" }
  );
  assert.equal(result.legal, true);
  assert.deepEqual([...result.unit.zoc_hexes].sort(), Rules.neighbors("2424").sort());
});

test("external AI combat intel applies ridge defense and cancels D retreats", () => {
  const built = combatContext();
  const result = Transcript.runTool(
    { ctx: built.ctx, allUnits: built.allUnits },
    built.publicContext,
    "check_combat",
    { attackers: ["attacker"], defender_hexes: ["2524"] }
  );
  assert.equal(result.legal, true, result.reason);
  assert.equal(result.details.defense, 2);
  assert.equal(result.details.crt_column["1"], "No Effect");

  const candidate = built.publicContext.candidate_actions.find((item) => item.action?.type === "combat");
  const target = candidate?.evaluation?.targets?.find((item) => item.hex === "2524");
  assert.equal(target?.terrain_defense_bonus, 0);
  assert.equal(target?.terrain_defense_multiplier, 2);
  assert.equal(target?.rugged_defense_cancels_retreat, true);
});
