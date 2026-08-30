import { tool } from "@opencode-ai/plugin";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getToolDefinitions, resolveToolProfile } = require("../core/agent_tools.js");
const { normalizeOpenCodeToolArgs } = require("../core/opencode_tool_args.js");
const { renderSidePrompt } = require("../core/prompt_registry.js");

const bridgeUrl = process.env.ALAMEIN_RULE_BRIDGE_URL;
const bridgeToken = process.env.ALAMEIN_RULE_BRIDGE_TOKEN;
const toolProfile = resolveToolProfile(process.env.ALAMEIN_TOOL_PROFILE || "map_and_action");
const toolDefinitions = Object.fromEntries(getToolDefinitions(toolProfile).map((definition) => [definition.name, definition]));

async function callBridge(name, args, context) {
  if (!bridgeUrl || !bridgeToken) throw new Error("wargame rule bridge is not configured");
  const response = await fetch(`${bridgeUrl}/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` },
    body: JSON.stringify({
      tool: name,
      arguments: normalizeOpenCodeToolArgs(name, args),
      session_id: context.sessionID
    })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `rule bridge status ${response.status}`);
  return JSON.stringify(result);
}

function schemaNode(schema) {
  let node;
  if (Array.isArray(schema.enum)) node = tool.schema.enum(schema.enum);
  else if (schema.type === "string") node = tool.schema.string();
  else if (schema.type === "array") node = tool.schema.array(schemaNode(schema.items || {}));
  else if (schema.type === "object" && schema.properties) node = tool.schema.object(schemaShape(schema));
  else if (schema.type === "object") node = tool.schema.record(tool.schema.string(), tool.schema.any());
  else if (schema.type === "integer") node = tool.schema.number().int();
  else if (schema.type === "number") node = tool.schema.number();
  else if (schema.type === "boolean") node = tool.schema.boolean();
  else node = tool.schema.any();
  if (schema.type === "string" && Number.isInteger(schema.minLength)) node = node.min(schema.minLength);
  if (schema.type === "array" && Number.isInteger(schema.minItems)) node = node.min(schema.minItems);
  return node;
}

function schemaShape(schema) {
  const required = new Set(schema.required || []);
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([name, property]) => {
    const node = schemaNode(property);
    return [name, required.has(name) ? node : node.optional()];
  }));
}

function toolSet() {
  return Object.fromEntries(toolProfile.tools.map((name) => {
    const definition = toolDefinitions[name];
    return [name, tool({
      description: definition.description,
      args: schemaShape(definition.parameters),
      execute: (args, context) => callBridge(name, args, context)
    })];
  }));
}

export const WargamePlugin = async () => ({
  tool: toolSet(),
  async "experimental.session.compacting"(_input, output) {
    const side = process.env.ALAMEIN_ACTIVE_SIDE || "";
    output.prompt = renderSidePrompt(side, "harness.compaction");
  }
});

export default WargamePlugin;
