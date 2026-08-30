"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { summarizeMovementPatterns } = require("../experiments/external_ai_full_game_transcript.js");

test("movement pattern summary counts reversals, repeated destinations, and concentration", () => {
  const summary = summarizeMovementPatterns([
    { source: "external_model", action: { type: "move", unit: "a", path: ["0101", "0201"], destination: "0201" } },
    { source: "external_model", action: { type: "move", unit: "a", path: ["0201", "0101"], destination: "0101" } },
    { source: "external_model", action: { type: "move", unit: "a", path: ["0101", "0201"], destination: "0201" } },
    { source: "external_model", action: { type: "move", unit: "b", path: ["0301", "0201"], destination: "0201" } },
    { source: "rules_ai", action: { type: "move", unit: "c", path: ["0401", "0201"], destination: "0201" } }
  ]);

  assert.equal(summary.moves, 4);
  assert.equal(summary.immediate_reversals, 2);
  assert.equal(summary.repeated_destination_actions, 2);
  assert.deepEqual(summary.top_destination_hexes[0], { hex: "0201", count: 3 });
  assert.equal(summary.top_three_destination_share, 1);
});

test("movement pattern summary restores paths from model steps when game log actions are compact", () => {
  const summary = summarizeMovementPatterns([
    { step: 1, source: "external_model", action: { type: "move", unit: "a", destination: "0201" } },
    { step: 2, source: "external_model", action: { type: "move", unit: "a", destination: "0101" } }
  ], "external_model", [
    { step: 1, final_action: { type: "move", unit: "a", path: ["0101", "0201"], destination: "0201" } },
    { step: 2, final_action: { type: "move", unit: "a", path: ["0201", "0101"], destination: "0101" } }
  ]);

  assert.equal(summary.moves, 2);
  assert.equal(summary.immediate_reversals, 1);
  assert.equal(summary.repeated_destination_actions, 1);
  assert.equal(summary.top_destination_hexes.length, 2);
});
