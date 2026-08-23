// createRpcClientHub composes TWO projections — ClientAPIAll<DeepSocketListenSmart<T>> —
// so the replay detector must recognise its own output. A server member spells the journal
// tail `getSince`; once projected, the client surface spells it `since`. In 2.12.0 the
// detector knew only the server spelling, so on the second pass it missed and the new
// IsListenMember branch claimed the member, collapsing it to a plain subscription and losing
// line/since/keyframe. Single-pass tests cannot see that: the loss needs two passes.
import type {DeepSocketListen, DeepSocketListenSmart} from '../src/Common/rcp/listen-deep'
import type {ClientAPIAll, ClientAPIStrict} from '../src/Common/rcp/rpc-client'
import type {ReplayEvent} from '../src/Common/events/replay-listen'
import type {ReplayRemote} from '../src/Common/events/replay-wire'
import type {createListen} from '../src/Common/events/Listen'

type tEv = [{tick: number}]

// the shape exposeReplay hands to the RPC facade
type tServerReplay = {
    on: (cb: (...a: tEv) => void) => () => void
    getSince: (seq: number) => ReplayEvent<tEv>[] | null
    keyframe: () => ReplayEvent<tEv> | undefined
    line: {on: (cb: (e: ReplayEvent<tEv>) => void) => () => void}
    frame: (seq: number) => ReplayEvent<tEv>[]
}
type tApi = {
    events: tServerReplay
    ticks: ReturnType<typeof createListen<[number]>>   // plain Listen, must stay a subscription
    add(a: number, b: number): number
}

// --- one pass: the direct lane ---
declare const single: ClientAPIAll<tApi>
const singleRemote: ReplayRemote<tEv> = single.events

// --- two passes: what the hub actually composes ---
declare const hub: ClientAPIAll<DeepSocketListenSmart<tApi>>
const hubRemote: ReplayRemote<tEv> = hub.events

// the members that went missing must all be reachable
function hubReplayMembersAreReachable() {
    const line = hub.events.line
    const since = hub.events.since
    const keyframe = hub.events.keyframe
    return {line, since, keyframe}
}

// --- the strict lane composes the same way ---
declare const strict: ClientAPIStrict<DeepSocketListenSmart<tApi>>
const strictRemote: ReplayRemote<tEv> = strict.events

// --- the other inner projection must compose too ---
declare const viaDeep: ClientAPIAll<DeepSocketListen<tApi>>
const viaDeepRemote: ReplayRemote<tEv> = viaDeep.events

// --- idempotence proper: a third pass may not degrade it either ---
declare const thrice: ClientAPIAll<DeepSocketListenSmart<DeepSocketListenSmart<tApi>>>
const thriceRemote: ReplayRemote<tEv> = thrice.events

// --- the 2.12.0 gain must survive: a PLAIN Listen member is still a subscription handle ---
function plainListenStillProjectsToAHandle() {
    const off = hub.ticks.on(v => void (v as number))
    off()
    off.unsubscribe()
}

// @ts-expect-error a plain Listen member is not a replay remote — the detector must stay narrow
const plainIsNotReplay: ReplayRemote<[number]> = hub.ticks

// --- ordinary methods are untouched by either branch ---
async function ordinaryCallsUnchanged() {
    const sum: number = await hub.add(1, 2)
    return sum
}
