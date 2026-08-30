"use strict";

function normalizeOpenCodeToolArgs(name, args) {
  if (name !== "act" || !args?.action?.action || args.action.type) return args;
  return { ...args, action: args.action.action };
}

module.exports = { normalizeOpenCodeToolArgs };
