// =====================================================================
// effects — external effects as intents in state, executed at-least-once
// =====================================================================
// TEMPLATE-OWNED. A command never calls a payment provider, a lock or a mail
// gateway: it records an INTENT in the state (a fact the line replicates and
// the archive keeps), and this runner, host-side next to the authority,
// performs the intent and reports the OUTCOME back as a system command whose
// requestId is the intent id — so the outcome is idempotent through the
// receipts, the provider call is idempotent through the intent id, and a
// crash between the two replays into the same facts. What a retry means is
// therefore decided once, here: perform at-least-once with backoff, report
// until it lands. The runner is pure host glue over the public Store API;
// promotion into the library waits for a second consumer (STARTUP-COMPOSITION).

import type {Store} from '../../../src/Common/Observe/store'

export type tEffectOutcome = {ok: true, result: unknown} | {ok: false, error: string}

export type EffectRunnerDeps<S extends Record<string, any>, I> = {
    /** The authority's own store (the line the intents live on). */
    store: Store<S>
    /** Top-level keys whose change re-selects the pending intents. */
    keys: readonly (keyof S & string)[]
    /** The pending intents, from the state (pure). */
    select: (state: S) => I[]
    /** The stable identity of an intent — the provider's idempotency key and the outcome's requestId. */
    id: (intent: I) => string
    /** The external call, at-least-once. */
    perform: (intent: I) => Promise<unknown>
    /** Record the outcome as a fact; must be idempotent (a system command keyed by the intent id). */
    report: (intent: I, outcome: tEffectOutcome) => Promise<unknown>
    /** Backoff between attempts (default 500ms, doubling) and the attempt cap (default 5) before a failure is reported. */
    retry?: {delayMs?: number, max?: number}
    log?: (line: string) => void
}

export function createEffectRunner<S extends Record<string, any>, I>(deps: EffectRunnerDeps<S, I>) {
    const delayMs = deps.retry?.delayMs ?? 500
    const maxAttempts = deps.retry?.max ?? 5
    const log = deps.log ?? (() => {})
    const inflight = new Map<string, {attempts: number, timer?: ReturnType<typeof setTimeout>}>()
    const stats = {performed: 0, failed: 0, reported: 0, retries: 0}
    let closed = false
    let scheduled = false

    // ============== the loop: state change → select → perform → report ==============
    function schedule() {
        if (closed || scheduled) return
        scheduled = true
        queueMicrotask(function sweep() {
            scheduled = false
            if (closed) return
            for (const intent of deps.select(deps.store.snapshot())) {
                const id = deps.id(intent)
                if (inflight.has(id)) continue
                inflight.set(id, {attempts: 0})
                void attempt(intent, id)
            }
        })
    }
    async function attempt(intent: I, id: string) {
        const entry = inflight.get(id)
        if (!entry || closed) return
        entry.attempts++
        let outcome: tEffectOutcome
        try {
            outcome = {ok: true, result: await deps.perform(intent)}
            stats.performed++
        } catch (error) {
            const message = (error as Error)?.message ?? String(error)
            if (entry.attempts < maxAttempts && !closed) {
                stats.retries++
                log(`effect ${id} attempt ${entry.attempts} failed (${message}); retrying`)
                entry.timer = setTimeout(function retryPerform() { void attempt(intent, id) }, delayMs * 2 ** (entry.attempts - 1))
                return
            }
            stats.failed++
            outcome = {ok: false, error: message}
        }
        await land(intent, id, outcome)
    }
    /** Report until it lands: the outcome is a fact the state must learn. */
    async function land(intent: I, id: string, outcome: tEffectOutcome) {
        let wait = delayMs
        while (!closed) {
            try {
                await deps.report(intent, outcome)
                stats.reported++
                break
            } catch (error) {
                log(`effect ${id}: report failed (${(error as Error)?.message ?? error}); retrying`)
                await new Promise(resolve => setTimeout(resolve, wait))
                wait = Math.min(wait * 2, 30_000)
            }
        }
        inflight.delete(id)
        // the reported fact may itself have produced new intents
        schedule()
    }

    const offs = deps.keys.map(key => (deps.store.node as any)[key].on(schedule) as () => void)
    schedule()

    return {
        /** Counters since boot: performed, failed (after the attempt cap), reported, retries. */
        stats: () => ({...stats, inflight: inflight.size}),
        /** Re-select now (a host may call it after restoring an archive). */
        kick: schedule,
        close() {
            closed = true
            for (const off of offs) off()
            for (const entry of inflight.values()) if (entry.timer) clearTimeout(entry.timer)
            inflight.clear()
        },
    }
}
export type EffectRunner = ReturnType<typeof createEffectRunner>
