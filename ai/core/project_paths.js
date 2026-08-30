"use strict";

const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const AI_ROOT = path.join(PROJECT_ROOT, "ai");
const CONFIG_DIR = path.join(AI_ROOT, "config");
const PROMPT_DIR = path.join(AI_ROOT, "prompt");
const LOG_DIR = path.join(PROJECT_ROOT, "log");

module.exports = {
  AI_ROOT,
  CONFIG_DIR,
  LOG_DIR,
  PROMPT_DIR,
  PROJECT_ROOT
};
