"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSessionRegistry = createSessionRegistry;
function createSessionRegistry() {
    const sessions = new Map();
    function track(account, control) {
        let tracked = sessions.get(account);
        if (!tracked)
            sessions.set(account, tracked = new Set());
        tracked.add(control);
    }
    function untrack(account, control) {
        const tracked = sessions.get(account);
        if (!tracked)
            return;
        tracked.delete(control);
        if (tracked.size == 0)
            sessions.delete(account);
    }
    function cut(account, reason) {
        let cutCount = 0;
        for (const control of [...(sessions.get(account) ?? [])]) {
            if (control.revoke(reason))
                cutCount++;
        }
        return cutCount;
    }
    return { track, untrack, cut };
}
