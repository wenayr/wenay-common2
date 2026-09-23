import assert from 'node:assert/strict'
import {createAudioSource, decodeMediaFrame} from '../../src/Common/media/media-index'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>(function pending(ok, fail) { resolve = ok; reject = fail })
    return {promise, resolve, reject}
}

function track() {
    const listeners = new Set<() => void>()
    let stopped = 0
    return {stop() { stopped++ }, stopped: () => stopped, listeners,
        addEventListener(_event: string, cb: () => void) { listeners.add(cb) },
        removeEventListener(_event: string, cb: () => void) { listeners.delete(cb) },
        end() { for (const cb of [...listeners]) cb() }}
}

async function main() {
    const g = globalThis as any
    const originals = {MediaRecorder: g.MediaRecorder, AudioContext: g.AudioContext, AudioWorkletNode: g.AudioWorkletNode}
    const recorders: any[] = []
    class Recorder {
        ondataavailable: any
        onerror: any
        onstop: any
        stopped = 0
        constructor() { recorders.push(this) }
        static isTypeSupported() { return true }
        start() {}
        stop() { this.stopped++; this.onstop?.() }
    }
    const unhandled: unknown[] = []
    function rejected(error: unknown) { unhandled.push(error) }
    process.on('unhandledRejection', rejected)
    g.MediaRecorder = Recorder
    const tracks: ReturnType<typeof track>[] = []
    const source = createAudioSource({mode: 'record', stream() {
        const next = track(); tracks.push(next)
        return {getTracks: () => [next]}
    }})
    const frames: number[][] = []
    let off = source[1].on(bytes => frames.push([...decodeMediaFrame(bytes).payload]))
    const chunk = (promise: Promise<ArrayBuffer>) => ({data: {size: 1, arrayBuffer: () => promise}})
    try {
        await source.start()
        const old = recorders.at(-1)
        const pending = deferred<ArrayBuffer>()
        const pendingError = deferred<ArrayBuffer>()
        const delayed = old.ondataavailable(chunk(pending.promise))
        const failing = old.ondataavailable(chunk(pendingError.promise))
        const staleCallback = old.ondataavailable
        const staleError = old.onerror
        source.stop()
        assert.equal(old.ondataavailable, null)
        assert.equal(tracks[0].listeners.size, 0)
        assert.equal(tracks[0].stopped(), 1)
        off()
        off = source[1].on(bytes => frames.push([...decodeMediaFrame(bytes).payload]))
        await source.start()
        pending.resolve(Uint8Array.of(17).buffer)
        pendingError.reject(new Error('old blob failed'))
        await Promise.all([delayed, failing])
        await staleCallback(chunk(Promise.resolve(Uint8Array.of(18).buffer)))
        staleError({error: new Error('old recorder failed')})
        assert.equal(source.state, 'live')
        assert.deepEqual(frames, [])
        await recorders.at(-1).ondataavailable(chunk(Promise.resolve(Uint8Array.of(23).buffer)))
        assert.deepEqual(frames, [[23]])
        const switched = deferred<ArrayBuffer>()
        const oldDevice = recorders.at(-1).ondataavailable(chunk(switched.promise))
        await source.setDevice('next')
        switched.resolve(Uint8Array.of(24).buffer)
        await oldDevice
        assert.deepEqual(frames, [[23]])
        tracks.at(-1)!.end()
        assert.equal(source.state, 'idle')
        await source.start()
        await recorders.at(-1).ondataavailable(chunk(Promise.reject(new Error('current blob failed'))))
        assert.equal(source.state, 'error')
        assert.match(source.getStats().error!, /current blob failed/)
        assert.equal(tracks.at(-1)!.stopped(), 1)

        // A superseded getUserMedia rejection cannot change the next recording.
        const grant = deferred<any>()
        let attempts = 0
        const grants = createAudioSource({mode: 'record', stream: () => ++attempts == 1 ? grant.promise : {getTracks: () => []}})
        try {
            const first = grants.start()
            await grants.setDevice('changed while requesting')
            grant.reject(new Error('old grant rejected'))
            await first
            assert.equal(grants.state, 'live')
        } finally { grants.stop() }

        // Worklet module completion owns its original context, even across stop/start.
        const contexts: any[] = []
        const modules: ReturnType<typeof deferred<void>>[] = []
        class Context {
            closed = 0
            sampleRate = 48000
            module = deferred<void>()
            audioWorklet = {addModule: () => this.module.promise}
            constructor() { contexts.push(this); modules.push(this.module) }
            createMediaStreamSource() { return {connect() {}, disconnect() {}} }
            close() { this.closed++; return Promise.resolve() }
        }
        const worklets: any[] = []
        class Worklet {
            port = {onmessage: null as any}
            constructor(readonly context: Context) { worklets.push(this) }
            disconnect() {}
        }
        g.AudioContext = Context
        g.AudioWorkletNode = Worklet
        const pcm = createAudioSource({stream: () => ({getTracks: () => []})})
        try {
            const first = pcm.start()
            await new Promise(resolve => setImmediate(resolve))
            pcm.stop()
            const second = pcm.start()
            await new Promise(resolve => setImmediate(resolve))
            modules[1].resolve()
            await second
            modules[0].resolve()
            await first
            assert.equal(pcm.state, 'live')
            assert.equal(contexts[0].closed, 1)
            assert.equal(contexts[1].closed, 0)
            assert.equal(worklets.length, 1)
            assert.equal(worklets[0].context, contexts[1])
            const staleSamples = worklets[0].port.onmessage
            pcm.stop()
            assert.equal(worklets[0].port.onmessage, null)
            assert.doesNotThrow(() => staleSamples({data: {}}))
        } finally { pcm.stop() }
        await new Promise(resolve => setImmediate(resolve))
        assert.deepEqual(unhandled, [])
    } finally {
        source.stop(); off()
        Object.assign(g, originals)
        process.off('unhandledRejection', rejected)
    }
    console.log('PASS M1: old chunks/errors, unsubscribe/stop, device switch, track end, failed grant and worklet generations')
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
