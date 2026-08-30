"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

function readYaml(file, source) {
  const document = YAML.parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true
  });
  if (document.errors.length) {
    throw new Error(`invalid YAML in ${path.basename(file)}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return document.toJS({ maxAliasCount: 100 });
}

function readConfigFile(file) {
  const source = fs.readFileSync(file, "utf8");
  const extension = path.extname(file).toLowerCase();
  const value = extension === ".yaml" || extension === ".yml"
    ? readYaml(file, source)
    : JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path.basename(file)} must contain an object`);
  }
  return value;
}

module.exports = { readConfigFile };
