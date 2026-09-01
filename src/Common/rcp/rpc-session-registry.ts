// =====================================================================
// Session registry — RPC-AUTH rule 7 bookkeeping as ONE primitive
// =====================================================================
// Gated servers track which live RpcServerControl belongs to which account so
// a revocation can cut running sessions without waiting for the next HELLO.
// The discipline is easy to get subtly wrong (an emptied Set must leave the
// map, or a long-lived host grows one entry per departed account forever), so
// the scale authority and the store node share THIS implementation instead of
// keeping hand-rolled copies that drift.

import type {RpcServerControl} from './rpc-server'

export function createSessionRegistry() {
    const sessions = new Map<string, Set<RpcServerControl>>()

    function track(account: string, control: RpcServerControl) {
        let tracked = sessions.get(account)
        if (!tracked) sessions.set(account, tracked = new Set())
        tracked.add(control)
    }

    function untrack(account: string, control: RpcServerControl) {
        const tracked = sessions.get(account)
        if (!tracked) return
        tracked.delete(control)
        if (tracked.size == 0) sessions.delete(account)
    }

    /** Revoke every live session of the account; returns how many were cut. */
    function cut(account: string, reason: string) {
        let cutCount = 0
        for (const control of [...(sessions.get(account) ?? [])]) {
            if (control.revoke(reason)) cutCount++
        }
        return cutCount
    }

    return {track, untrack, cut}
}
export type SessionRegistry = ReturnType<typeof createSessionRegistry>
