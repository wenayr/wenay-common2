"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNodeHealth = createNodeHealth;
const store_1 = require("./store");
function createNodeHealth(deps) {
    const { node, intervalMs, now = Date.now, drain } = deps;
    const store = (0, store_1.createStore)({ node, startedTs: now(), refreshedTs: 0, parts: {} }, drain !== undefined ? { drain } : {});
    const probes = new Map();
    let closed = false;
    function refresh(name) {
        if (closed)
            return store.state;
        for (const [key, probe] of probes) {
            if (name != null && key != name)
                continue;
            try {
                store.state.parts[key] = probe();
            }
            catch (e) {
                store.state.parts[key] = { error: String(e?.message ?? e) };
            }
        }
        store.state.refreshedTs = now();
        return store.state;
    }
    function register(name, probe) {
        probes.set(name, probe);
        refresh(name);
        return function offProbe() {
            if (probes.get(name) != probe)
                return;
            probes.delete(name);
            delete store.state.parts[name];
        };
    }
    let timer = null;
    if (intervalMs != null) {
        timer = setInterval(function refreshNodeHealth() { refresh(); }, intervalMs);
        timer.unref?.();
    }
    return {
        store,
        register,
        refresh,
        close() {
            closed = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            probes.clear();
        },
    };
}
