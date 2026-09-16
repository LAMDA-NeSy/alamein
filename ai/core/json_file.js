"use strict";

const fs = require("node:fs");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { parser } = require("stream-json");
const Assembler = require("stream-json/Assembler");

// Split containers at record boundaries; native JSON handles escaping and values.
function* jsonChunks(value, split = true) {
  if (!split || value === null || typeof value !== "object" || typeof value.toJSON === "function") {
    try { yield JSON.stringify(value); return; }
    catch (error) {
      if (!(error instanceof RangeError) || !value || typeof value !== "object") throw error;
    }
  }
  if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i += 1) {
      if (i) yield ",";
      for (const chunk of jsonChunks(value[i], false)) yield chunk === undefined ? "null" : chunk;
    }
    yield "]";
    return;
  }
  yield "{";
  let first = true;
  for (const [key, item] of Object.entries(value)) {
    if (["undefined", "function", "symbol"].includes(typeof item)) continue;
    const parts = jsonChunks(item, Array.isArray(item));
    const initial = parts.next();
    if (initial.value === undefined) continue;
    if (!first) yield ",";
    first = false;
    yield `${JSON.stringify(key)}:`;
    yield initial.value;
    yield* parts;
  }
  yield "}";
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "w");
    let pending = [];
    let length = 0;
    for (const chunk of jsonChunks(value)) {
      if (chunk === undefined) throw new TypeError("JSON root is not serializable");
      if (chunk.length >= 1024 * 1024) {
        if (pending.length) fs.writeFileSync(fd, pending.join(""));
        pending = [];
        length = 0;
        fs.writeFileSync(fd, chunk);
        continue;
      }
      pending.push(chunk);
      length += chunk.length;
      if (length >= 1024 * 1024) {
        fs.writeFileSync(fd, pending.join(""));
        pending = [];
        length = 0;
      }
    }
    if (pending.length) fs.writeFileSync(fd, pending.join(""));
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  }
  catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

class JsonAssembler extends Assembler {
  _saveValue(value) {
    if (this.done || Array.isArray(this.current)) return super._saveValue(value);
    // Match JSON.parse for keys such as __proto__, without invoking setters.
    Object.defineProperty(this.current, this.key, { value, writable: true, enumerable: true, configurable: true });
    this.key = null;
  }
  stringValue(value) { this._saveValue(value); }
}

async function readJsonFile(file, { streamThreshold = 64 * 1024 * 1024 } = {}) {
  if (fs.statSync(file).size < streamThreshold) return JSON.parse(fs.readFileSync(file, "utf8"));
  const assembler = new JsonAssembler();
  await pipeline(fs.createReadStream(file), parser({ streamValues: false }), new Writable({
    objectMode: true,
    write(token, _encoding, callback) {
      try { assembler.consume(token); callback(); }
      catch (error) { callback(error); }
    }
  }));
  return assembler.current;
}

module.exports = { jsonChunks, readJsonFile, writeJsonAtomic };
