"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcDeadline = createRpcDeadline;
function createRpcDeadline(deps) {
    const maxTimerMs = 2_147_483_647;
    let timer;
    function arm() {
        const remaining = deps.at - Date.now();
        timer = remaining > maxTimerMs ? setTimeout(arm, maxTimerMs) : setTimeout(deps.fire, Math.max(remaining, 0));
        if (deps.unref)
            timer.unref?.();
    }
    arm();
    return { cancel() { clearTimeout(timer); } };
}
