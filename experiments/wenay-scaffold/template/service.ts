// =====================================================================
// {{name}} — the domain module. THE ONLY FILE a service author edits.
// =====================================================================
// The definition is pure domain data: the store shape, the commands
// (validate throws on bad input BEFORE any effect; apply mutates the store
// and returns the client's receipt), and the read projection. No env, no
// sockets, no crypto, no process — those are host concerns and live in the
// entrypoints (doc/DYNAMIC-RUNTIME.md ownership boundary).
//
// The placeholder domain below is a counter; replace it with your own
// (items + bookings, orders, whatever the service is about). Everything
// underneath — replication, directory, receipts, token corridor, drain —
// arrives already wired from ./leader.ts and ./node.ts.

import type {ServiceCommandCtx, tServiceDefinition} from './leader'

export type CounterState = Record<string, {id: string, value: number, ts: number}>

export const serviceDefinition = {
    /** Wire identity: the RPC wrap key every surface is served under. */
    name: '{{name}}',
    /** Replica-line coordinates; leader and nodes share them. */
    storeId: '{{name}}-store',
    originId: '{{name}}-origin',
    /** The authoritative store shape; nodes replicate it verbatim. */
    initial: {counter: {id: 'counter', value: 0, ts: 0}} as CounterState,
    commands: {
        add: {
            validate(input: {delta?: unknown}) {
                const delta = Number(input?.delta)
                if (!Number.isFinite(delta) || Math.abs(delta) > 1000) {
                    throw new Error('delta must be a finite number within ±1000')
                }
            },
            apply(ctx: ServiceCommandCtx<CounterState>, input: {delta: number}) {
                const value = (ctx.state.counter?.value ?? 0) + Number(input.delta)
                ctx.state.counter = {id: 'counter', value, ts: Date.now()}
                return {value, by: ctx.account}
            },
        },
    },
    /** Read policy: what an anonymous reader may see of the state. */
    readerFacet(state: CounterState) {
        return {counter: state.counter?.value ?? 0}
    },
} satisfies tServiceDefinition<CounterState>

/** The definition is the source of its own type; hosts consume the contract. */
export type ServiceDefinition = typeof serviceDefinition
