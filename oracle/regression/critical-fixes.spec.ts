// =====================================================================
//  Proof for the audit fixes that are demonstrable without a socket.
//
//  Every test here is written to FAIL on the code as it was before the fix, so it
//  answers "is this a real defect" rather than "does the new code run". Each one
//  states the production shape it models; a test that needs an artificial harness to
//  reach the defect says so, because that is evidence about how reachable it is.
// =====================================================================
import {createStore} from '../../src/Common/Observe/store'
import {flushReactive} from '../../src/Common/Observe/reactive'
import {createOfflineStore, createMemoryOfflineStorage, type OfflineStoreRecord} from '../../src/Common/Observe/store-offline'
import {exposeStoreLazyLine, syncStoreLazyLine, type StoreLazyChunkV1} from '../../src/Common/Observe/store-lazy-line'

type Test = {name: string, fn: () => void | Promise<void>}
const tests: Test[] = []
function test(name: string, fn: Test['fn']) { tests.push({name, fn}) }
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------
// 1. store-offline: one failed write must not discard the snapshot
// ---------------------------------------------------------------------
// Production shape: a browser cache whose write fails once — quota, a blocked
// IndexedDB transaction, a locked file. `dirty` was cleared BEFORE the await, so after
// the failure the flag said "nothing to save" and the retry in `finally` never armed.
// The snapshot was then withheld until the store happened to change again, which for a
// quiet store means until the tab closed.
test('store-offline: a transient write failure still persists the snapshot', async () => {
    const storage = createMemoryOfflineStorage()
    let failNext = false
    let writes = 0
    const flaky = {
        ...storage,
        async write<T>(key: string, value: T) {
            writes++
            if (failNext) { failNext = false; throw new Error('quota exceeded') }
            return storage.write(key, value)
        },
    }
    // no transaction(): keep the failure on the plain write path
    delete (flaky as {transaction?: unknown}).transaction

    const offline = await createOfflineStore<{tick: number}>({
        key: 'w',
        initial: {tick: 0},
        storage: flaky,
        debounceMs: 5,
        storeOpts: {drain: 'micro'},
    })
    await offline.ready

    offline.state.tick = 1
    failNext = true
    await offline.flush().catch(() => {})          // the failing write
    const afterFailure = await storage.read<OfflineStoreRecord<{tick: number}>>('w')
    assert(afterFailure?.snapshot?.tick != 1, 'precondition: the failed write stored nothing')

    // No further mutation. The reschedule armed by `finally` is the only thing that can save.
    await delay(80)
    const healed = await storage.read<OfflineStoreRecord<{tick: number}>>('w')
    assert(healed?.snapshot?.tick == 1,
        `snapshot must survive one failed write and land on the retry (writes=${writes}, got=${JSON.stringify(healed?.snapshot)})`)
    offline.close()
})

// ---------------------------------------------------------------------
// 2. lazy line: a key named __proto__ must reach the mirror
// ---------------------------------------------------------------------
// Production shape: store keys are application data. A dictionary keyed by anything a
// user or an upstream feed can name will eventually contain "__proto__" — and the
// failure is silent: the key is neither transferred nor reported missing.
test('lazy line: a "__proto__" key survives host chunking and reaches the mirror', async () => {
    const source = createStore<Record<string, {v: number}>>({})
    source.state['alpha'] = {v: 1}
    // defineProperty, not assignment: an ASSIGNMENT here would swap the source store's own
    // prototype and the test would never publish the key at all. The host is what must carry it.
    Reflect.defineProperty(source.state, '__proto__', {
        configurable: true, enumerable: true, writable: true, value: {v: 42},
    })
    source.state['omega'] = {v: 2}
    await flushReactive(source.state)

    const host = exposeStoreLazyLine(source, {})
    const chunks: StoreLazyChunkV1[] = []
    for (let guard = 0; guard < 20; guard++) {
        const page = host.api.read({cursor: null, maxBytes: 4_000}, chunk => { chunks.push(chunk) })
        if ((page as {filled?: boolean}).filled) break
    }

    const carried = chunks.some(chunk => Object.keys(chunk.values).includes('__proto__'))
    assert(carried, 'the host chunk must carry "__proto__" as an OWN key, not as a prototype swap')

    const mirror = createStore<Record<string, {v: number}>>({}, {drain: 'micro'})
    const sync = syncStoreLazyLine(mirror, host.api, {})
    await sync.ready
    await flushReactive(mirror.state)

    const own = Object.prototype.hasOwnProperty.call(mirror.state, '__proto__')
    assert(own, 'the mirror must hold "__proto__" as an own key')
    assert((mirror.state as Record<string, {v: number}>)['__proto__']?.v == 42,
        'the mirrored value must be the one that was published')
    assert(mirror.state['alpha']?.v == 1 && mirror.state['omega']?.v == 2, 'neighbouring keys unaffected')
    sync.close()
    host.close()
})

// ---------------------------------------------------------------------
// 3. audio source: a second start() must not orphan the first grant
// ---------------------------------------------------------------------
// Production shape: a double click on "enable microphone", or setDevice() while the
// first getUserMedia prompt is still open. stop() runs synchronously BEFORE the await,
// so it cannot cancel a start that has not resolved yet: both grants land, the second
// overwrites the shared fields, and the first MediaStream is never stopped — the
// browser keeps its recording indicator lit and its worklet keeps pushing PCM into the
// same shell. The video source has carried this guard all along; audio did not.
test('audio source: an overtaken start() releases its own stream', async () => {
    const g = globalThis as any
    const originalAudioContext = g.AudioContext
    const originalWorkletNode = g.AudioWorkletNode
    try {
        function FakeAudioContext(this: any) {
            this.sampleRate = 48000
            this.audioWorklet = {async addModule() {}}
            this.createMediaStreamSource = () => ({connect() {}, disconnect() {}})
            this.close = () => {}
        }
        function FakeAudioWorkletNode(this: any) {
            this.port = {onmessage: null}
            this.disconnect = () => {}
        }
        g.AudioContext = FakeAudioContext
        g.AudioWorkletNode = FakeAudioWorkletNode

        const stopped: string[] = []
        const makeStream = (label: string) => ({getTracks: () => [{stop() { stopped.push(label) }}]})
        let releaseFirst: (v: any) => void = () => {}
        let releaseSecond: (v: any) => void = () => {}
        const pending = [
            new Promise(resolve => { releaseFirst = resolve }),
            new Promise(resolve => { releaseSecond = resolve }),
        ]
        let handed = 0
        const {createAudioSource} = await import('../../src/Common/media/media-source')
        const source = createAudioSource({sourceId: 'mic', stream: () => pending[handed++]})

        const firstStart = source.start()
        const secondStart = source.start()          // overtakes before the first resolves
        releaseFirst(makeStream('first'))
        releaseSecond(makeStream('second'))
        await firstStart
        await secondStart

        assert(stopped.includes('first'),
            `the overtaken grant must be released, not leaked (stopped=${JSON.stringify(stopped)})`)
        assert(!stopped.includes('second'), 'the winning grant must stay live')
        source.stop()
        assert(stopped.includes('second'), 'stop() releases the live grant')
    } finally {
        g.AudioContext = originalAudioContext
        g.AudioWorkletNode = originalWorkletNode
    }
})

async function main() {
    let failed = 0
    for (const {name, fn} of tests) {
        try { await fn(); console.log(`ok - ${name}`) }
        catch (error) { failed++; console.error(`not ok - ${name}`); console.error(String((error as Error)?.message ?? error)) }
    }
    if (failed > 0) throw new Error(`${failed} critical-fix regression test(s) failed`)
    console.log(`${tests.length} critical-fix regression tests passed`)
}

main().catch(error => { console.error(error); process.exit(1) })
