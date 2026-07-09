// Publish-path reconnect correctness (peer SDK): the relay journal never lies
// after a publisher gap. Gap matrix on createPatchRelayJournal + rejection-driven
// repair in createPeerClient ('tail' | 'keyframe'), sacred eviction, resync().
import {flushReactive} from '../src/Common/Observe/reactive'
import {applyStorePatch, createStore, StorePatch} from '../src/Common/Observe/store'
import {syncStoreReplay} from '../src/Common/Observe/store-replay'
import {createPatchRelayJournal, createPeerClient, PatchEnvelope, PeerRemote} from '../src/Common/peer/peer-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const json = (v: any) => JSON.stringify(v)

async function waitFor(label: string, cond: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (cond()) return
        await delay(10)
    }
    throw new Error(`timeout: ${label}`)
}

const env = (seq: number, path: PropertyKey[], value: any): PatchEnvelope =>
    ({seq, ts: seq, event: [{path, value, exists: value !== undefined}]})
const root = (seq: number, value: any) => env(seq, [], value)

type World = {n: number, tag?: string}

// lossy transport wrapper: drops pushes while `offline` is true — the client's
// next successful delivery gets the {seq} verdict and repairs the gap
function makeLossyRemote(journal: ReturnType<typeof createPatchRelayJournal>, account: string) {
    const state = {offline: false, dropped: 0}
    const remote: PeerRemote = {
        signal: {send: async () => false, signals: {on: () => () => {}}},
        publish: (e: PatchEnvelope) => {
            if (state.offline) { state.dropped++; return true }
            return journal.push(e)
        },
        peers: {[account]: journal.remote as any},
    }
    return {remote, state}
}

async function main() {
    console.log('\n[peer-repair] gap matrix on the relay journal')
    {
        const j = createPatchRelayJournal({history: 16})
        ok(j.push(env(0, ['n'], 1)) != true && json(j.push(env(0, ['n'], 1))) == json({seq: -1}),
            'folding journal refuses a non-root FIRST envelope (partial-state lie) with repair coord -1')
        ok(j.push(root(0, {n: 1})) == true, 'root first envelope accepted')
        ok(j.push(env(1, ['n'], 2)) == true && j.push(env(2, ['n'], 3)) == true, 'contiguous envelopes accepted')
        ok(j.push(env(2, ['n'], 99)) == true && j.seq() == 2 && j.snapshot().n == 3,
            'duplicate is an idempotent no-op (reconnect overlap)')
        ok(json(j.push(env(5, ['n'], 6))) == json({seq: 2}), 'non-root gap rejected WITH the repair coordinate')
        ok(j.seq() == 2 && j.snapshot().n == 3, 'rejected gap does not corrupt the fold')
        ok(j.push(root(7, {n: 7})) == true && j.seq() == 7 && j.snapshot().n == 7,
            'root patch with a gap = legitimate reset point (keyframe repair / owner restart)')
        ok(j.push(root(3, {n: 3})) == true && j.seq() == 3,
            'root patch with a LOWER seq = owner restart reset')
        ok(json(j.remote.keyframe()?.event[0].value) == json({n: 3}), 'folded keyframe stays truthful throughout')
    }

    console.log('\n[peer-repair] sacred journal: never invents, strict contiguity')
    {
        const j = createPatchRelayJournal({history: 2, gap: 'sacred'})
        ok(j.push(root(0, {n: 0})) == true && j.push(env(1, ['n'], 1)) == true, 'sacred accepts a contiguous line')
        ok(json(j.push(root(5, {n: 5}))) == json({seq: 1}), 'sacred rejects even a ROOT patch with a gap (no reset semantics)')
        ok(j.remote.keyframe() == null, 'sacred never folds a keyframe')
        j.push(env(2, ['n'], 2)); j.push(env(3, ['n'], 3)) // history 2 -> seq 0,1 evicted
        let threw = false
        try { j.remote.frame!(0) } catch { threw = true }
        ok(threw, 'sacred frame() on an evicted tail THROWS (loud, never a silent seq jump)')
        ok(json(j.remote.since(1)?.map(e => e.seq)) == json([2, 3]), 'covered tail is still served exactly')
    }

    console.log('\n[peer-repair] tail repair: lossless catch-up after an offline window')
    {
        const j = createPatchRelayJournal({history: 64})
        const net = makeLossyRemote(j, 'a')
        const errors: unknown[] = []
        const a = createPeerClient<World>({
            remote: net.remote, account: 'a', initial: {n: 0},
            repair: 'tail', drain: 'micro', onPublishError: e => errors.push(e),
        })
        await waitFor('warmup', () => j.seq() >= 0)

        a.store.state.n = 1
        await flushReactive(a.store.state)
        await waitFor('live publish', () => j.snapshot().n == 1)

        net.state.offline = true
        a.store.state.n = 2
        a.store.state.tag = 'missed'
        await flushReactive(a.store.state)
        a.store.state.n = 3
        await flushReactive(a.store.state)
        await delay(20)
        net.state.offline = false
        ok(net.state.dropped >= 2 && j.snapshot().n == 1, 'offline window: relay is behind, fold untouched')

        a.store.state.n = 4
        await flushReactive(a.store.state)
        await waitFor('tail repair', () => j.snapshot().n == 4)
        ok(j.snapshot().tag == 'missed', 'tail repair delivered the MISSED envelopes verbatim (lossless)')
        ok(json(j.snapshot()) == json(a.store.snapshot()), 'relay converged with the owner')
        // ring integrity: a late joiner can fold the line from any covered coordinate
        const late = createStore<World>({n: -1}, {drain: 'micro'})
        const sub = syncStoreReplay(late, j.remote)
        await sub.ready
        ok(json(late.state) == json(a.store.snapshot()), 'late joiner folds a truthful state after repair')
        ok(errors.length == 0, 'no publish errors on the happy repair path')
        sub(); a.close()
    }

    console.log('\n[peer-repair] keyframe repair: cheap reset for ephemeral state')
    {
        const j = createPatchRelayJournal({history: 64})
        const net = makeLossyRemote(j, 'a')
        const a = createPeerClient<World>({
            remote: net.remote, account: 'a', initial: {n: 0},
            repair: 'keyframe', drain: 'micro',
        })
        await waitFor('warmup', () => j.seq() >= 0)
        net.state.offline = true
        a.store.state.n = 100
        await flushReactive(a.store.state)
        await delay(20)
        net.state.offline = false
        a.store.state.n = 101
        await flushReactive(a.store.state)
        await waitFor('keyframe repair', () => j.snapshot().n == 101)
        ok(json(j.snapshot()) == json(a.store.snapshot()), 'keyframe repair resets the relay to current state')
        a.close()
    }

    console.log('\n[peer-repair] sacred + local eviction: loud publisher fault, journal stays truthful')
    {
        const j = createPatchRelayJournal({history: 64, gap: 'sacred'})
        const net = makeLossyRemote(j, 'a')
        const errors: unknown[] = []
        const a = createPeerClient<World, 'sacred'>({
            remote: net.remote, account: 'a', initial: {n: 0},
            journal: 'sacred', repair: 'tail', history: 2, // tiny local journal -> eviction
            drain: 'micro', onPublishError: e => errors.push(e),
        })
        await waitFor('warmup', () => j.seq() >= 0)
        const seqBefore = j.seq()
        net.state.offline = true
        for (let i = 1; i <= 6; i++) { a.store.state.n = i; await flushReactive(a.store.state) }
        net.state.offline = false
        a.store.state.n = 7
        await flushReactive(a.store.state)
        await waitFor('sacred repair failure surfaces', () => errors.length > 0)
        ok(String(errors[0]).includes('unrepairable'), `publisher fault is loud: ${String(errors[0]).slice(0, 90)}`)
        ok(j.seq() == seqBefore, 'sacred journal stayed truthful (nothing invented, nothing gapped)')
        a.close()
    }

    console.log('\n[peer-repair] resync(): repair without waiting for the next write')
    {
        const j = createPatchRelayJournal({history: 64})
        const net = makeLossyRemote(j, 'a')
        const a = createPeerClient<World>({remote: net.remote, account: 'a', initial: {n: 0}, drain: 'micro'})
        await waitFor('warmup', () => j.seq() >= 0)
        net.state.offline = true
        a.store.state.n = 5
        a.store.state.tag = 'silent'
        await flushReactive(a.store.state)
        await delay(20)
        net.state.offline = false
        ok(j.snapshot().n == 0, 'relay is behind and no further writes are coming')
        await a.resync()
        ok(json(j.snapshot()) == json(a.store.snapshot()) && j.snapshot().tag == 'silent',
            'resync() repaired the journal without a new write')
        a.close()
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
