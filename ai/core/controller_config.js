"use strict";

const SIDES = Object.freeze(["axis", "allies"]);
const CONTROLLERS = Object.freeze(["human", "heuristic_ai", "rules_ai", "external_ai"]);

function controllerError(value) {
  return new Error(`invalid controller ${String(value)}; expected one of ${CONTROLLERS.join(", ")}`);
}

function normalizeController(value, fallback = "rules_ai") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!CONTROLLERS.includes(normalized)) throw controllerError(value);
  return normalized;
}

function sideWithExternalController(controllers) {
  const sides = SIDES.filter((side) => controllers[side] === "external_ai");
  return sides.length === 1 ? sides[0] : null;
}

/**
 * Resolve the same controller vocabulary used by the browser setup screen.
 * Explicit side options win; the old --external-side flag is only a legacy
 * mapping and is never applied when no flag was actually supplied.
 */
function resolveControllers(options = {}) {
  const explicit = options.controllers && typeof options.controllers === "object"
    ? options.controllers
    : {};
  const hasExplicitSide = options.axisController != null || options.alliesController != null
    || explicit.axis != null || explicit.allies != null;
  const legacySide = options.externalSide == null || options.externalSide === ""
    ? null
    : String(options.externalSide).trim().toLowerCase();
  if (legacySide != null && !SIDES.includes(legacySide)) {
    throw new Error(`invalid external side ${legacySide}; expected axis or allies`);
  }
  const controllers = {
    axis: normalizeController(
      options.axisController ?? explicit.axis ?? (hasExplicitSide ? "rules_ai" : legacySide === "axis" ? "external_ai" : "rules_ai")
    ),
    allies: normalizeController(
      options.alliesController ?? explicit.allies ?? (hasExplicitSide ? "rules_ai" : legacySide === "allies" ? "external_ai" : "rules_ai")
    )
  };
  return Object.freeze({
    ...controllers,
    external_side: sideWithExternalController(controllers),
    explicit: hasExplicitSide,
    legacy_external_side: legacySide
  });
}

function controllerMetadata(controllers) {
  const resolved = resolveControllers({ controllers });
  return {
    controllers: { axis: resolved.axis, allies: resolved.allies },
    axis_controller: resolved.axis,
    allies_controller: resolved.allies,
    external_side: resolved.external_side
  };
}

module.exports = {
  CONTROLLERS,
  SIDES,
  controllerMetadata,
  normalizeController,
  resolveControllers,
  sideWithExternalController
};
