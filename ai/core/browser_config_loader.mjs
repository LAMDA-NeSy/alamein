import { parse } from "../../node_modules/yaml/browser/index.js";

const configUrl = new URL("../config/ai_config.yaml", import.meta.url);
const promptUrl = new URL("../prompt/prompts.yaml", import.meta.url);
const axisPromptUrl = new URL("../prompt/axis_prompts.yaml", import.meta.url);
const alliesPromptUrl = new URL("../prompt/allies_prompts.yaml", import.meta.url);
const appUrl = new URL("../../app.js?v=20260806-3", import.meta.url);

async function loadYaml(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} request failed with ${response.status}`);
  const config = parse(await response.text());
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${label} must contain a YAML mapping`);
  }
  return config;
}

function browserStrategy(strategy = {}) {
  return {
    doctrine: strategy.doctrine || "",
    actionContract: strategy.action_contract || "",
    phaseObjectives: strategy.phase_objectives || {},
    priorities: strategy.priorities || []
  };
}

function loadApplication() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = appUrl.href;
    script.onload = resolve;
    script.onerror = () => reject(new Error("app.js failed to load"));
    document.body.append(script);
  });
}

try {
  const [config, promptRegistry, axisRegistry, alliesRegistry] = await Promise.all([
    loadYaml(configUrl, "AI configuration"),
    loadYaml(promptUrl, "AI prompt registry"),
    loadYaml(axisPromptUrl, "Axis AI prompt profile"),
    loadYaml(alliesPromptUrl, "Allies AI prompt profile")
  ]);
  globalThis.ALAMEIN_AI_PROMPTS = Object.freeze(promptRegistry.prompts || {});
  globalThis.ALAMEIN_AI_SIDE_PROFILES = Object.freeze({
    axis: Object.freeze({ prompts: axisRegistry.prompts || {}, strategy: browserStrategy(axisRegistry.strategy) }),
    allies: Object.freeze({ prompts: alliesRegistry.prompts || {}, strategy: browserStrategy(alliesRegistry.strategy) })
  });
  globalThis.ALAMEIN_AI_CONFIG = Object.freeze({ ...config, strategy: browserStrategy(promptRegistry.strategy) });
}
catch (error) {
  console.error("AI configuration or side prompt profile failed to load.", error);
  globalThis.ALAMEIN_AI_CONFIG_ERROR = error;
  throw error;
}

await loadApplication();
