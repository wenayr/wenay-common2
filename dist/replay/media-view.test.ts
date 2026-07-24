// ============================================================
//  replay/media-view.test.ts
//
//  Media viewer helpers oracle (Node, no browser):
//  - attachAudioPlayer: PCM decode, sequential playhead, live
//    backlog drop, enable/disable, non-audio frames ignored
//  - attachVideoCanvas: injected bitmap decoder, sizing follows
//    frames, busy-skip keeps latest, stats
//  - pipeMediaPublish: sentAt stamp, onError on rejection
// ============================================================

import {listen} from '../src/Common/events/Listen'
import {
    attachAudioPlayer,
    attachVideoCanvas,
    encodeMediaFrame,
    pipeMediaPublish,
} from '../src/Common/media/media-index'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function pcmFrame(seq: number, nSamples = 480, sampleRate = 48000) {
    const pcm = new Int16Array(nSamples)
    for (let i = 0; i < nSamples; i++) pcm[i] = (i % 2 ? 1 : -1) * 1000
    return encodeMediaFrame({kind: 'audio-pcm', codec: 'pcm16', seq, tMono: seq, sampleRate, channels: 1, nSamples}, new Uint8Array(pcm.buffer))
}

function videoFrame(seq: number, width: number, height: number) {
    return encodeMediaFrame({kind: 'video-frame', codec: 'jpeg', seq, tMono: seq, width, height}, new Uint8Array([1, 2, 3]))
}

function createFakeAudioContext() {
    const scheduled: {at: number, frames: number}[] = []
    const ctx = {
        currentTime: 0,
        destination: {},
        resumed: 0,
        closed: 0,
        resume() { ctx.resumed++ },
        close() { ctx.closed++ },
        createBuffer: (_ch: number, frames: number, _rate: number) => ({
            frames,
            getChannelData: () => new Float32Array(frames),
        }),
        createBufferSource: () => {
            const node: any = {connect: () => {}, start: (at: number) => scheduled.push({at, frames: node.buffer.frames})}
            return node
        },
        scheduled,
    }
    return ctx
}

async function main() {
    console.log('\n[media-view] audio player: sequential playhead + live backlog drop')
    {
        const [emit, line] = listen<[Uint8Array, number]>()
        const ctx = createFakeAudioContext()
        const player = attachAudioPlayer(line as any, {audioContext: () => ctx as any})

        emit(pcmFrame(1), Date.now())
        ok(player.stats().frames == 1 && player.stats().played == 0, 'disabled player counts frames but schedules nothing')

        player.enable()
        ok(player.enabled && ctx.resumed == 1, 'enable() builds the injected context and resumes it')

        emit(pcmFrame(2), Date.now() - 100)
        ok(player.stats().played == 1 && ctx.scheduled.length == 1, 'enabled player schedules a decoded pcm16 buffer')
        ok(ctx.scheduled[0].frames == 480, 'sample count survives decode (480 frames)')
        ok(player.stats().ageMs >= 80, 'sentAt stamp turns into a real age measurement')

        const before = ctx.scheduled.length
        emit(videoFrame(3, 320, 240), Date.now())
        ok(ctx.scheduled.length == before && player.stats().frames == 3, 'video frames on an audio player are counted, not scheduled')

        // 40 x 10ms chunks pushed instantly = 0.4s of queued audio while currentTime stays 0
        for (let i = 0; i < 40; i++) emit(pcmFrame(10 + i), Date.now())
        ok(player.stats().dropped > 0, 'backlog past maxBacklogSec is dropped (live policy), not queued forever')
        const last = ctx.scheduled[ctx.scheduled.length - 1]
        ok(last.at <= 0.45, `playhead rebased near "now" after the drop (last at=${last.at.toFixed(2)}s)`)

        player.disable()
        ok(!player.enabled && ctx.closed == 1, 'disable() closes the context')
        player.off()
    }

    console.log('\n[media-view] video canvas: sizing follows frames, busy-skip keeps latest')
    {
        const [emit, line] = listen<[Uint8Array, number]>()
        const drawnImages: any[] = []
        const errors: unknown[] = []
        let bitmapCloses = 0
        let drawFails = false
        let blobBytes: number[] = []
        const canvas: any = {
            width: 0,
            height: 0,
            getContext: () => ({
                drawImage: (img: any) => {
                    if (drawFails) throw new Error('draw failed')
                    drawnImages.push(img)
                },
            }),
        }
        let decodeDelay = 0
        const view = attachVideoCanvas(line as any, canvas, {
            createBitmap: async blob => {
                if (decodeDelay) await delay(decodeDelay)
                blobBytes = [...new Uint8Array(await blob.arrayBuffer())]
                return {size: blob.size, close: () => { bitmapCloses++ }}
            },
            onError: error => errors.push(error),
        })

        emit(videoFrame(1, 640, 480), Date.now() - 100)
        await delay(10)
        ok(view.stats().drawn == 1 && drawnImages.length == 1, 'video frame decoded via injected bitmap factory and drawn')
        ok(canvas.width == 640 && canvas.height == 480, 'canvas takes the frame size')
        ok(view.stats().width == 640 && view.stats().ageMs >= 80, 'stats expose frame size and age')

        emit(pcmFrame(2), Date.now())
        await delay(10)
        ok(view.stats().drawn == 1 && view.stats().frames == 2, 'audio frame on a video canvas is counted, not drawn')

        decodeDelay = 30
        const mutableFrame = videoFrame(3, 1280, 720)
        emit(mutableFrame, Date.now())
        mutableFrame.fill(9)
        emit(videoFrame(4, 1280, 720), Date.now())   // arrives while frame 3 decodes -> skipped
        await delay(60)
        ok(view.stats().frames == 4 && view.stats().drawn == 2, 'busy-skip: overlapping frame dropped, not queued')
        ok(canvas.width == 1280 && canvas.height == 720, 'canvas resized to the new resolution')
        ok(blobBytes.join(',') == '1,2,3', 'Blob snapshots its payload without a preceding Uint8Array copy')
        ok(bitmapCloses == 2, 'every successfully decoded bitmap is closed')

        decodeDelay = 0
        drawFails = true
        emit(videoFrame(5, 320, 240), Date.now())
        await delay(10)
        drawFails = false
        ok(errors.length == 1 && bitmapCloses == 3, 'a draw failure still closes the decoded bitmap')

        decodeDelay = 30
        emit(videoFrame(6, 320, 240), Date.now())
        await delay(5)
        view.off()
        await delay(40)
        ok(view.stats().drawn == 2 && bitmapCloses == 4, 'off() suppresses an in-flight draw and closes its bitmap')
        emit(videoFrame(7, 320, 240), Date.now())
        await delay(10)
        ok(view.stats().frames == 6, 'off() unsubscribes the line')
    }

    console.log('\n[media-view] publish pipe: stamp + onError')
    {
        const [emit, line] = listen<[Uint8Array]>()
        const sent: {frame: Uint8Array, sentAt?: number}[] = []
        const errors: unknown[] = []
        const off = pipeMediaPublish(line as any, (frame, sentAt) => {
            sent.push({frame, sentAt})
            return frame.byteLength == 0 ? Promise.reject(new Error('boom')) : Promise.resolve(true)
        }, {onError: e => errors.push(e)})

        emit(pcmFrame(1))
        ok(sent.length == 1 && typeof sent[0].sentAt == 'number', 'frames are published with a wall-clock stamp by default')

        emit(new Uint8Array(0))
        await delay(10)
        ok(errors.length == 1, 'publish rejection lands in onError, capture loop survives')

        off()
        emit(pcmFrame(2))
        ok(sent.length == 2, 'off() stops publishing')

        const noStamp: (number | undefined)[] = []
        const [emit2, line2] = listen<[Uint8Array]>()
        pipeMediaPublish(line2 as any, (_f, sentAt) => { noStamp.push(sentAt) }, {stamp: false})
        emit2(pcmFrame(3))
        ok(noStamp.length == 1 && noStamp[0] == undefined, 'stamp:false publishes without a timestamp')
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
