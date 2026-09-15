"use strict";

function objectsInText(text) {
  const value = String(text || "").trim();
  if (!value) return [];
  try { return [JSON.parse(value)]; } catch {}
  const objects = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") { if (depth++ === 0) start = index; }
    else if (char === "}" && depth > 0 && --depth === 0) {
      try { objects.push(JSON.parse(value.slice(start, index + 1))); } catch {}
    }
  }
  return objects;
}

function unwrap(value) {
  const wrappers = [];
  for (let depth = 0; depth < 3; depth += 1) {
    if (!value || typeof value !== "object" || Array.isArray(value)) break;
    // Only an unambiguous envelope is normalized. Never infer missing fields.
    const keys = Object.keys(value);
    if (keys.length !== 1 || !["answer", "final_answer"].includes(keys[0])) break;
    wrappers.push(keys[0]);
    value = value[keys[0]];
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return { value: null, wrappers }; }
    }
  }
  return { value, wrappers };
}

function parseModelObject(result, accepts = () => true, label = "model") {
  const message = result?.response_json?.choices?.[0]?.message || {};
  for (const source of ["content", "reasoning_content"]) {
    const candidates = objectsInText(message[source]).map(unwrap).filter(({ value }) =>
      value && typeof value === "object" && !Array.isArray(value) && accepts(value));
    const unique = new Map(candidates.map((candidate) => [JSON.stringify(candidate.value), candidate]));
    if (unique.size > 1) return { error: `${label} ambiguous JSON in ${source}`, parse_status: "ambiguous" };
    if (unique.size === 1) {
      const { value, wrappers } = unique.values().next().value;
      return { ...value, response_source: source, parse_status: wrappers.length ? "normalized_envelope" : "parsed",
        response_wrappers: wrappers };
    }
  }
  return { error: `${label} returned no valid JSON in content or reasoning_content`, parse_status: "invalid" };
}

module.exports = { objectsInText, parseModelObject };
