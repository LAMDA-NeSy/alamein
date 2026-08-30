"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { LOG_DIR } = require("./project_paths.js");

function defaultLogFile(filename) {
  return path.join(LOG_DIR, filename);
}

function prepareOutputFile(filename) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

module.exports = {
  LOG_DIR,
  defaultLogFile,
  prepareOutputFile
};
