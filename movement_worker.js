importScripts("./rule_engine.js");

self.addEventListener("message", (event) => {
  const request = event.data || {};
  const { id, type, state, rules, terrain, unitId, targetHex, options, revision } = request;
  try {
    const workerState = structuredClone(state);
    self.AlameinRules.applyStateDefaults(workerState, { terrain });
    const context = self.AlameinRules.createContext({ state: workerState, rules, terrain });
    if (type === "reachable") {
      const reachable = self.AlameinRules.reachableHexes(context, unitId, options || {});
      self.postMessage({ id, type, revision, result: [...reachable.entries()] });
      return;
    }
    if (type === "path") {
      const path = self.AlameinRules.findLegalPath(context, unitId, targetHex, options || {});
      self.postMessage({ id, type, revision, result: path });
      return;
    }
    if (type === "diagnose") {
      const result = self.AlameinRules.diagnoseUnreachableMove(context, unitId, targetHex, options || {});
      self.postMessage({ id, type, revision, result });
      return;
    }
    throw new Error(`unknown movement request: ${type}`);
  }
  catch (error) {
    self.postMessage({ id, type, revision, error: error?.message || String(error) });
  }
});
