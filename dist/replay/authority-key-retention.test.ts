// ============================================================
//  replay/authority-key-retention.test.ts
//
//  Soak guard for the incident class "a top-level key vanished from the
//  authority's own store under churn". An authority-like replica set (leader,
//  NO offers) keeps rewriting key A while key B was written exactly once;
//  around it churn compressed in time: short-lived follower nodes catching up
//  via CHUNKED keyframes (the state is large enough to split at the default
//  budget), cascade readers through those nodes, a long-lived replica-set
//  client forced through route hand-offs (clean and dirty), and the journal
//  byte budget (keepBytes) tight enough to prune on every burst. The oracle
//  asserts after every cycle that NO reader path ever feeds back into the
//  authoritative store: key B stays, the key set stays exact, and a pure-read
//  phase leaves the authority's head untouched.
//
//  Field context (2026-08-29): a live stand reported exactly this symptom; the
//  probe showed headSeq == tick.value (the line never carried the lost key's
//  event) and line age == process age — a silent process RESTART with a fresh
//  initial state, not a library deletion. This oracle pins the library half:
//  no churn combination may EVER remove a key from a leader with no offers.
//  Run: npx tsx replay/authority-key-retention.test.ts
// ============================================================

import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createStoreReplicaSet} from '../src/Common/Observe/store-replica-set'
import {decodeStoreReplayBatchV2} from '../src/Common/Observe/store-replay-codec'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function settle(times = 1) { for (let i = 0; i < times; i++) await tick() }

async function waitFor(message: string, check: () => boolean, timeoutMs = 5000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        if (check()) { ok(true, message); return true }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    ok(false, message + ' (timed out)')
    return false
}

type Entry = {id: string, value: number, payload: string}
type State = Record<string, Entry>

const FILLER_KEYS = 12
const FILLER_BYTES = 40 * 1024
const TICK_BYTES = 2 * 1024
const CYCLES = 16
const TICKS_PER_CYCLE = 20

function initialState() {
    const state: State = {tick: {id: 'tick', value: 0, payload: 'x'.repeat(TICK_BYTES)}}
    for (let i = 0; i < FILLER_KEYS; i++) {
        const id = 'filler-' + String(i).padStart(2, '0')
        state[id] = {id, value: i, payload: 'f'.repeat(FILLER_BYTES)}
    }
    return state
}

function expectedKeys(withCounter: boolean) {
    const keys = ['tick']
    for (let i = 0; i < FILLER_KEYS; i++) keys.push('filler-' + String(i).padStart(2, '0'))
    if (withCounter) keys.push('counter')
    return keys.sort().join(',')
}

function keySetOf(state: Record<string, unknown>) {
    return Object.keys(state).sort().join(',')
}

function keyframeRootValue(wire: unknown) {
    if (wire == null) return null
    const event = decodeStoreReplayBatchV2(wire)
    const patch = event.event[0][0]
    if (!patch || patch.path.length != 0 || !patch.exists) return null
    return patch.value as State
}

async function main() {
    // ============== the authority: leader, no offers, byte-pruned journal ==============
    const authority = createStoreReplicaSet<State>({
        storeId: 'retention', originId: 'retention-origin', nodeId: 'authority', lineId: 'authority-line',
        initial: initialState(),
        leadership: {initialRole: 'leader', epoch: 1},
        // keepBytes is a few tick entries: every burst prunes, every late catch-up
        // must fall back to the (chunked) keyframe instead of a journal tail
        expose: {history: 256, keepBytes: 6 * 1024},
    })
    const state = authority.control.store.state
    // Every journal event is observed from seq 1: any reader path injecting an
    // event into the authoritative line would break the accounting law below.
    let lineEvents = 0
    const offLine = (authority.api.replay as any).line.on(function countAuthorityLineEvent() { lineEvents++ })
    let tickWrites = 0
    function advanceTick() {
        tickWrites++
        state.tick = {id: 'tick', value: tickWrites, payload: 'x'.repeat(TICK_BYTES)}
    }
    async function tickBurst(count: number) {
        for (let i = 0; i < count; i++) {
            advanceTick()
            await settle()
        }
    }

    // key A moves first, then key B lands exactly once — never touched again
    await tickBurst(8)
    state.counter = {id: 'counter', value: 10, payload: 'counter-written-once'}
    await settle(2)
    ok(keySetOf(authority.control.store.snapshot()) == expectedKeys(true),
        'the authority holds tick + fillers + the once-written counter')

    const keyframeSizeHint = FILLER_KEYS * FILLER_BYTES
    const beginProbe = await (authority.api.fragment.replay as any).chunks.begin()
    ok(beginProbe != null && beginProbe.total >= 2,
        `the keyframe splits at the default budget (total ${beginProbe?.total}, ~${Math.round(keyframeSizeHint / 1024)}KB state)`)
    if (beginProbe) (authority.api.fragment.replay as any).chunks.end(beginProbe.snapshotId)

    // ============== the long-lived replica-set client (a browser stand-in) ==============
    const client = createStoreReplicaSet<State>({
        storeId: 'retention', originId: 'retention-origin', nodeId: 'client-1', lineId: 'client-1-line',
        initial: {} as State,
        leadership: {initialRole: 'follower', eligible: false},
        route: {reconnectMs: 50},
    })
    function offerTo(id: string, fragment: any) {
        return {id, connect: () => ({remote: fragment, close() {}})}
    }
    client.control.addOffer(offerTo('direct', authority.api.fragment))
    await client.api.ready
    ok(client.api.store.state.counter?.value == 10, 'the client catches up and sees the once-written counter')

    // ============== churn helpers ==============
    type Child = {
        index: number
        node: ReturnType<typeof createStoreReplicaSet<State>>
        offerId: string
    }
    let childIndex = 0
    async function spawnChild(): Promise<Child> {
        const index = ++childIndex
        const node = createStoreReplicaSet<State>({
            storeId: 'retention', originId: 'retention-origin',
            nodeId: 'child-' + index, lineId: 'child-' + index + '-line',
            initial: {} as State,
            leadership: {initialRole: 'follower', eligible: false},
            route: {reconnectMs: 50},
            expose: {history: 256, keepBytes: 6 * 1024},
        })
        node.control.addOffer(offerTo('to-authority', authority.api.fragment))
        await node.api.ready
        return {index, node, offerId: 'via-child-' + index}
    }

    async function verifyCascadeReader(child: Child) {
        const reader = createStoreFollower<State>({remote: child.node.api.fragment.replay as any})
        await reader.ready
        const snapshot = reader.store.snapshot()
        ok(snapshot.counter?.value == 10 && keySetOf(snapshot) == expectedKeys(true),
            `cycle child-${child.index}: a cascade reader through the node sees the full key set`)
        reader.close()
    }

    async function verifyAuthorityIntact(label: string) {
        const snapshot = authority.control.store.snapshot()
        const stateOk = snapshot.counter?.value == 10 && keySetOf(snapshot) == expectedKeys(true)
        const keyframe = keyframeRootValue(await (authority.api.fragment.replay as any).keyframe())
        const keyframeOk = keyframe != null && keyframe.counter?.value == 10
            && keySetOf(keyframe) == expectedKeys(true)
        const status = authority.api.status.state
        ok(stateOk && keyframeOk && status.role == 'leader' && status.conflicts == 0,
            label + ': authority store + keyframe intact, still leader, zero conflicts')
    }

    // ============== the churn: catch-ups, cascades, hand-offs, prune pressure ==============
    let liveChildren: Child[] = []
    for (let cycle = 0; cycle < CYCLES; cycle++) {
        await tickBurst(TICKS_PER_CYCLE)

        const child = await spawnChild()
        const childState = child.node.api.store.snapshot()
        ok(childState.counter?.value == 10 && keySetOf(childState) == expectedKeys(true),
            `cycle ${cycle}: child-${child.index} assembled the chunked keyframe with the full key set`)
        await verifyCascadeReader(child)

        // hand the client over to the cascade (ANY live child wins fork-choice
        // once 'direct' is gone), then verify nothing was lost on the way
        client.control.addOffer(offerTo(child.offerId, child.node.api.fragment))
        client.control.removeOffer('direct')
        await client.control.reconcile('oracle hand-off to child')
        const tickAtHandOff = tickWrites
        await waitFor(`cycle ${cycle}: the client re-followed via a child route and kept converging`,
            () => client.api.status.state.routeId != null
                && client.api.status.state.routeId != 'direct'
                && (client.api.store.state.tick?.value ?? 0) >= tickAtHandOff
                && client.api.store.state.counter?.value == 10)

        // back to direct; the via-child offer stays until the child is retired
        client.control.addOffer(offerTo('direct', authority.api.fragment))

        // retire the PREVIOUS child: odd indexes leave cleanly (offer removed
        // first), even indexes die dirty (closed while possibly still routed)
        liveChildren.push(child)
        if (liveChildren.length > 1) {
            const retiring = liveChildren.shift()!
            if (retiring.index % 2 == 1) {
                client.control.removeOffer(retiring.offerId)
                retiring.node.close()
            } else {
                retiring.node.close()
                await settle(2)
                client.control.removeOffer(retiring.offerId)
            }
            await waitFor(`cycle ${cycle}: the client survives child-${retiring.index} retirement on a live route`,
                () => (client.api.status.state.routeId == 'direct'
                        || client.api.status.state.routeId == child.offerId)
                    && client.api.store.state.counter?.value == 10)
        }

        await verifyAuthorityIntact(`cycle ${cycle}`)
    }

    const window = (authority.api.replay as any).journalWindow()
    ok(window.cappedByBytes == true && window.bytes <= 6 * 1024,
        `the byte budget really pruned during the run (retained ${window.entries} entries, ${window.bytes} bytes)`)

    // ============== pure-read quiescence: reads must never write ==============
    const headBefore = (authority.api.replay as any).head()
    const snapshotBefore = JSON.stringify(authority.control.store.snapshot())
    const probes: Array<{close: () => void}> = []
    for (let i = 0; i < 3; i++) {
        const child = await spawnChild()
        probes.push({close: () => child.node.close()})
    }
    for (let i = 0; i < 2; i++) {
        const reader = createStoreFollower<State>({remote: authority.api.fragment.replay as any})
        await reader.ready
        probes.push({close: () => reader.close()})
    }
    const begin = await (authority.api.fragment.replay as any).chunks.begin()
    if (begin) {
        const parts = [begin.chunk0]
        for (let index = 1; index < begin.total; index++) {
            parts.push(await (authority.api.fragment.replay as any).chunks.pull(begin.snapshotId, index))
        }
        const covered = new Set<string>()
        let duplicates = 0
        for (const wire of parts) {
            for (const key of Object.keys(keyframeRootValue(wire) ?? {})) {
                if (covered.has(key)) duplicates++
                covered.add(key)
            }
        }
        ok(covered.has('counter') && duplicates == 0 && [...covered].sort().join(',') == expectedKeys(true),
            'chunked parts cover every top-level key exactly once, counter included')
        ;(authority.api.fragment.replay as any).chunks.end(begin.snapshotId)
    } else {
        ok(false, 'chunks.begin answered null in the quiescence phase')
    }
    await settle(4)
    for (const probe of probes) probe.close()
    ok((authority.api.replay as any).head() == headBefore,
        'a pure-read churn phase (catch-ups, chunk pulls) left the authority head untouched')
    ok(JSON.stringify(authority.control.store.snapshot()) == snapshotBefore,
        'the authoritative state is byte-identical after the pure-read phase')

    // ============== the incident probe, replayed: a fresh lean reader ==============
    const freshReader = createStoreFollower<State>({remote: authority.api.fragment.replay as any})
    await freshReader.ready
    const freshState = freshReader.store.snapshot()
    ok(freshState.counter?.value == 10 && keySetOf(freshState) == expectedKeys(true),
        'a fresh lean reader after all churn sees counter and the exact key set')
    freshReader.close()

    // seq accounting — the law that exposed the field incident: the line holds
    // ONLY writer-produced events. Drain coalescing may merge adjacent writes
    // (head below the write count is legal), but nothing may ever push head
    // ABOVE it — a reader-injected event would do exactly that.
    const head = (authority.api.replay as any).head()
    offLine()
    ok(head == lineEvents && head <= tickWrites + 1,
        `journal accounting holds: head ${head} == ${lineEvents} observed events, ceiling ${tickWrites} tick writes + 1`)

    for (const child of liveChildren) child.node.close()
    client.close()
    authority.close()
    console.log(fails == 0 ? '\nauthority-key-retention: ALL GREEN' : `\nauthority-key-retention: ${fails} FAILURES`)
    if (fails) process.exitCode = 1
}
void main()
