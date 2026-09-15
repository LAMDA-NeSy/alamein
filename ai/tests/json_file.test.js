"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { jsonChunks, readJsonFile, writeJsonAtomic } = require("../core/json_file.js");

function outputFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sae-json-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "transcript.json");
}

test("chunked transcript JSON matches native serialization and streaming reads", async (t) => {
  const file = outputFile(t);
  const value = { scenario: "october", missing: undefined,
    model_steps: [{ text: "\u4e2d\u6587\n\"\\", values: [undefined, NaN, Infinity, null, true, -2.5] }],
    nested: { omitted: undefined, array: [1, 2] }, date: new Date("2026-09-12T00:00:00Z") };
  writeJsonAtomic(file, value);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(value));
  assert.deepEqual(await readJsonFile(file, { streamThreshold: 0 }), JSON.parse(JSON.stringify(value)));
  assert.deepEqual(await readJsonFile(file), JSON.parse(JSON.stringify(value)));
});

test("transcript arrays serialize by record rather than one ever-growing string", async (t) => {
  const file = outputFile(t);
  const value = { model_steps: Array.from({ length: 2000 }, (_, step) => ({ step, text: "x".repeat(4096) })) };
  let chunks = 0;
  let maxLength = 0;
  for (const chunk of jsonChunks(value)) { chunks += 1; maxLength = Math.max(maxLength, chunk.length); }
  assert.ok(chunks > value.model_steps.length);
  assert.ok(maxLength < 5000);
  writeJsonAtomic(file, value);
  assert.deepEqual(await readJsonFile(file, { streamThreshold: 0 }), value);
});

test("failed serialization preserves the last checkpoint and removes the temporary file", async (t) => {
  const file = outputFile(t);
  writeJsonAtomic(file, { checkpoint: 1 });
  assert.throws(() => writeJsonAtomic(file, { model_steps: [{ bad: 1n }] }), TypeError);
  assert.deepEqual(await readJsonFile(file), { checkpoint: 1 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => writeJsonAtomic(file, { model_steps: [cyclic] }), TypeError);
  assert.deepEqual(await readJsonFile(file), { checkpoint: 1 });
});

test("streaming JSON preserves prototype-like keys and rejects incomplete data", async (t) => {
  const file = outputFile(t);
  const value = JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":"plain"},"__defineGetter__":3}');
  writeJsonAtomic(file, value);
  const actual = await readJsonFile(file, { streamThreshold: 0 });
  assert.deepEqual(actual, value);
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal({}.polluted, undefined);
  fs.truncateSync(file, fs.statSync(file).size - 1);
  await assert.rejects(readJsonFile(file, { streamThreshold: 0 }));
});
