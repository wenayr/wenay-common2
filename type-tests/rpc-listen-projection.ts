// A Listen member reached through the typed client lane must hand back a usable
// subscription handle. Before 2.12.0 the object recursion in ClientAPIAll met `on`
// as an ordinary method and mapped it to Promise<DeepDataOnly<SubscriptionHandle>>;
// the handle is callable, DeepDataOnly erases Function, and the member collapsed to
// Promise<never> — so doc/wenay-common2.md told readers to cast the whole facade to
// DeepSocketListen. These checks pin that the cast is no longer needed.
import type {createListen} from '../src/Common/events/Listen'
import type {DeepSocketListen, DeepSocketListenSmart} from '../src/Common/rcp/listen-deep'
import type {ClientAPIAll, ClientAPIStrict} from '../src/Common/rcp/rpc-client'

type tTicks = ReturnType<typeof createListen<[number]>>
type tApi = {
    ticks: tTicks
    add(a: number, b: number): number
    nested: {beats: tTicks}
}

// the hub path: DeepSocketListenSmart first, then the client lane
type tHubClient = ClientAPIAll<DeepSocketListenSmart<tApi>>
declare const hub: tHubClient

function subscriptionHandleSurvivesTheHubPath() {
    const off = hub.ticks.on(function onTick(v) {
        const value: number = v          // callback arg stays typed
        void value
    })
    off()                                 // callable handle
    off.off()
    off.unsubscribe()
    off.removeCallback()
    return off as Promise<void>           // still awaitable, as before
}

// @ts-expect-error the handle is not a plain Promise<never> any more
const notNever: Promise<never> = hub.ticks.on(() => {})

// nesting must behave the same one level down
function subscriptionHandleSurvivesNesting() {
    const off = hub.nested.beats.on(v => void (v as number))
    off()
}

// an ordinary method is untouched by the new branch
async function ordinaryCallsUnchanged() {
    const sum: number = await hub.add(1, 2)
    return sum
}

// the direct lane (no DeepSocketListenSmart in front) projects identically
declare const direct: ClientAPIAll<tApi>
function directLaneMatches() {
    const off = direct.ticks.on(v => void (v as number))
    off()
}

// strict lane carries the same shape
declare const strict: ClientAPIStrict<DeepSocketListenSmart<tApi>>
function strictLaneMatches() {
    const off = strict.ticks.on(v => void (v as number))
    off()
}

// the documented cast still compiles — it is now redundant, not wrong
declare const legacy: ClientAPIAll<DeepSocketListenSmart<tApi>>
function documentedCastStillWorks() {
    const l = legacy as unknown as DeepSocketListen<tApi>
    const off = l.ticks.on(v => void (v as number))
    off()
}
