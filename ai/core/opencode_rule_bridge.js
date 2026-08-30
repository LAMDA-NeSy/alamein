"use strict";

const { createActionRuleBridge } = require("./action_rule_bridge.js");

function createRuleBridge(config, options = {}) {
  return createActionRuleBridge(config, { toolProfile: "map_and_action", ...options });
}

module.exports = { createRuleBridge, createActionRuleBridge };
