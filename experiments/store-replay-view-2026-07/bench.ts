// =====================================================================
// Store Replay View initial-transfer benchmark
// =====================================================================
// Each measured unit runs in a fresh --expose-gc process. The source Store is
// built before the baseline; measurements cover snapshot production plus the
// same pack + JSON materialization an RPC result/callback has to undergo.

import {spawnSync} from 'node:child_process'
import {performance} from 'node:perf_hooks'
import {resolve as resolvePath} from 'node:path'
import {
    createStore,
    type StorePatch,
} from '../../src/Common/Observe/store'
import {
    createStoreReplayView,
    exposeStoreReplay,
} from '../../src/Common/Observe/store-replay'
import {decodeStoreReplayBatchV2} from '../../src/Common/Observe/store-replay-codec'
import {packResult} from '../../src/Common/rcp/rpc-walk'

const MIB = 1024 * 1024
const SOURCE_KEYS = 1500
const SELECTED_KEYS = 500
const CHUNK_BYTES = 512 * 1024
const WINDOW_BYTES = 1024 * 1024
const MAX_ITEMS = 256
const RESULT_MARKER = '##STORE_REPLAY_VIEW_BENCH##'

type tCandidate = 'full-keyframe' | 'selected-keyframe' | 'selected-windowed'

type Row = {
    index: number
    payload: string
}

type State = Record<string, Row>

type UnitResult = {
    candidate: tCandidate
    targetMiB: number
    sourcePayloadBytes: number
    selectedPayloadBytes: number
    wallMs: number
    cpuProbeWallMs: number
    cpuMs: number
    cpuToWall: number
    payloadWireBytes: number
    transportValueBytes: number
    peakHeapDeltaBytes: number
    responseHeldHeapDeltaBytes: number
    postSendRetainedHeapDeltaBytes: number
    peakRssDeltaBytes: number
    chunks: number
    pages: number
    patches: number
    maxChunkPayloadBytes: number
    maxWindowTransportBytes: number
}

const candidates: readonly tCandidate[] = [
    'full-keyframe',
    'selected-keyframe',
    'selected-windowed',
]

function collectGarbage() {
    const gc = (globalThis as typeof globalThis & {gc?: () => void}).gc
    if (!gc) throw new Error('benchmark requires node --expose-gc')
    gc()
    gc()
}

function heapUsed() {
    return process.memoryUsage().heapUsed
}

function maxRssBytes() {
    return process.resourceUsage().maxRSS * 1024
}

function cpuMilliseconds(delta: NodeJS.CpuUsage) {
    return (delta.user + delta.system) / 1000
}

function keyAt(index: number) {
    return 'K' + index.toString().padStart(4, '0')
}

function flatAsciiPayload(index: number, byteLength: number) {
    const bytes = Buffer.allocUnsafe(byteLength)
    bytes.fill(97 + index % 26)
    const prefix = Buffer.from(index.toString(36).padStart(8, '0') + '|', 'ascii')
    prefix.copy(bytes, 0, 0, Math.min(prefix.length, bytes.length))
    return bytes.toString('latin1')
}

function createFixture(targetMiB: number) {
    const targetBytes = Math.round(targetMiB * MIB)
    const baseBytes = Math.floor(targetBytes / SOURCE_KEYS)
    let remainder = targetBytes - baseBytes * SOURCE_KEYS
    const state: State = {}
    const selected: string[] = []
    let sourcePayloadBytes = 0
    let selectedPayloadBytes = 0
    for (let index = 0; index < SOURCE_KEYS; index++) {
        const payloadBytes = baseBytes + (remainder-- > 0 ? 1 : 0)
        const key = keyAt(index)
        const payload = flatAsciiPayload(index, payloadBytes)
        state[key] = {index, payload}
        sourcePayloadBytes += Buffer.byteLength(payload)
        if (index % 3 == 0) {
            selected.push(key)
            selectedPayloadBytes += Buffer.byteLength(payload)
        }
    }
    if (selected.length != SELECTED_KEYS) {
        throw new Error('fixture selected ' + selected.length + ' keys, expected ' + SELECTED_KEYS)
    }
    return {state, selected, sourcePayloadBytes, selectedPayloadBytes}
}

function materialize(value: unknown) {
    const packed = packResult(value)
    const json = JSON.stringify(packed)
    return {
        packed,
        json,
        bytes: Buffer.byteLength(json),
    }
}

function nestedWireJsonBytes(json: string) {
    const marker = ',"wire":'
    const markerAt = json.lastIndexOf(marker)
    if (markerAt < 0 || json[json.length - 1] != '}') {
        throw new Error('snapshot callback value has no final wire member')
    }
    // The fixture and protocol metadata are ASCII-only, so characters are bytes.
    return json.length - markerAt - marker.length - 1
}

async function runUnit(candidate: tCandidate, targetMiB: number): Promise<UnitResult> {
    const fixture = createFixture(targetMiB)
    const source = createStore<State>(fixture.state, {drain: 'micro'})
    let full = candidate == 'full-keyframe'
        ? exposeStoreReplay(source, {history: 16})
        : undefined
    let view = candidate != 'full-keyframe'
        ? createStoreReplayView(source, {
            keys: fixture.selected,
            lineId: 'bench:' + candidate + ':' + targetMiB,
            history: 16,
            snapshot: {
                chunkBytes: CHUNK_BYTES,
                windowBytes: WINDOW_BYTES,
                maxItems: MAX_ITEMS,
            },
        })
        : undefined

    collectGarbage()
    const baselineHeap = heapUsed()
    const baselineRss = maxRssBytes()
    let peakHeap = baselineHeap
    function sampleHeap() {
        peakHeap = Math.max(peakHeap, heapUsed())
    }

    let heldWire: unknown
    let heldPacked: unknown
    let heldJson: string | undefined
    let payloadWireBytes = 0
    let transportValueBytes = 0
    let chunks = 0
    let pages = 0
    let patches = 0
    let maxChunkPayloadBytes = 0
    let maxWindowTransportBytes = 0
    const wallStart = performance.now()

    if (candidate == 'full-keyframe') {
        heldWire = await full!.api.replay.keyframe()
        patches = decodeStoreReplayBatchV2(heldWire).event[0].length
        let materialized: ReturnType<typeof materialize> | undefined = materialize(heldWire)
        heldPacked = materialized.packed
        heldJson = materialized.json
        payloadWireBytes = materialized.bytes
        transportValueBytes = materialized.bytes
        chunks = 1
        pages = 1
        maxChunkPayloadBytes = materialized.bytes
        maxWindowTransportBytes = materialized.bytes
        sampleHeap()
        materialized = undefined
    } else if (candidate == 'selected-keyframe') {
        heldWire = await view!.resource.replay.keyframe()
        patches = decodeStoreReplayBatchV2(heldWire).event[0].length
        if (patches != SELECTED_KEYS + 1) {
            throw new Error('selected keyframe has ' + patches + ' patches')
        }
        let materialized: ReturnType<typeof materialize> | undefined = materialize(heldWire)
        heldPacked = materialized.packed
        heldJson = materialized.json
        payloadWireBytes = materialized.bytes
        transportValueBytes = materialized.bytes
        chunks = 1
        pages = 1
        maxChunkPayloadBytes = materialized.bytes
        maxWindowTransportBytes = materialized.bytes
        sampleHeap()
        materialized = undefined
    } else {
        const opened = await view!.resource.snapshot.open()
        let page = 0
        let expectedChunkIndex = 0
        let rootPatches = 0
        const transferredKeys = new Set<string>()
        while (true) {
            const heldWindow: {packed: unknown, json: string}[] = []
            let windowTransportBytes = 0
            const result = await view!.resource.snapshot.read({
                transferId: opened.transferId,
                after: page,
                maxBytes: WINDOW_BYTES,
            }, function consumeChunk(chunk) {
                if (chunk.page != page || chunk.index != expectedChunkIndex++) {
                    throw new Error('out-of-order snapshot chunk')
                }
                const event = decodeStoreReplayBatchV2(chunk.wire)
                for (const patch of event.event[0]) {
                    patches++
                    if (patch.path.length == 0) rootPatches++
                    else if (patch.path.length == 1 && typeof patch.path[0] == 'string') {
                        transferredKeys.add(patch.path[0])
                    }
                }
                const transport = materialize(chunk)
                const chunkPayloadBytes = nestedWireJsonBytes(transport.json)
                payloadWireBytes += chunkPayloadBytes
                transportValueBytes += transport.bytes
                maxChunkPayloadBytes = Math.max(maxChunkPayloadBytes, chunkPayloadBytes)
                windowTransportBytes += transport.bytes
                heldWindow.push({packed: transport.packed, json: transport.json})
                chunks++
                sampleHeap()
            })
            pages++
            maxWindowTransportBytes = Math.max(maxWindowTransportBytes, windowTransportBytes)
            sampleHeap()
            heldWindow.length = 0
            if (!result.done) {
                page = result.next
                continue
            }
            if (result.retry) throw new Error('stable benchmark snapshot unexpectedly requested retry')
            if (rootPatches != 1 || transferredKeys.size != SELECTED_KEYS) {
                throw new Error(
                    'windowed snapshot transferred root=' + rootPatches
                    + ', keys=' + transferredKeys.size,
                )
            }
            view!.resource.snapshot.close(opened.transferId)
            break
        }
    }

    const wallMs = performance.now() - wallStart
    sampleHeap()
    const responseHeldHeap = heapUsed()
    const peakRss = maxRssBytes()

    heldWire = undefined
    heldPacked = undefined
    heldJson = undefined
    collectGarbage()
    const postSendHeap = heapUsed()

    async function runCpuProbeTransfer() {
        if (candidate == 'full-keyframe') {
            const wire = await full!.api.replay.keyframe()
            materialize(wire)
            return
        }
        if (candidate == 'selected-keyframe') {
            const wire = await view!.resource.replay.keyframe()
            materialize(wire)
            return
        }
        const opened = await view!.resource.snapshot.open()
        let page = 0
        while (true) {
            const result = await view!.resource.snapshot.read({
                transferId: opened.transferId,
                after: page,
                maxBytes: WINDOW_BYTES,
            }, function serializeCpuProbeChunk(chunk) {
                materialize(chunk)
            })
            if (result.done) {
                if (result.retry) throw new Error('CPU probe unexpectedly requested retry')
                view!.resource.snapshot.close(opened.transferId)
                return
            }
            page = result.next
        }
    }

    const cpuRepeats = candidate == 'selected-keyframe'
        ? (targetMiB <= 15 ? 15 : 5)
        : candidate == 'full-keyframe'
            ? (targetMiB <= 15 ? 8 : 3)
            : (targetMiB <= 15 ? 3 : 2)
    collectGarbage()
    const cpuStart = process.cpuUsage()
    const cpuWallStart = performance.now()
    for (let iteration = 0; iteration < cpuRepeats; iteration++) {
        await runCpuProbeTransfer()
    }
    const cpuProbeWallMs = (performance.now() - cpuWallStart) / cpuRepeats
    const cpuMs = cpuMilliseconds(process.cpuUsage(cpuStart)) / cpuRepeats

    full?.close()
    view?.close()
    full = undefined
    view = undefined

    return {
        candidate,
        targetMiB,
        sourcePayloadBytes: fixture.sourcePayloadBytes,
        selectedPayloadBytes: fixture.selectedPayloadBytes,
        wallMs,
        cpuProbeWallMs,
        cpuMs,
        cpuToWall: cpuProbeWallMs > 0 ? cpuMs / cpuProbeWallMs : 0,
        payloadWireBytes,
        transportValueBytes,
        peakHeapDeltaBytes: Math.max(0, peakHeap - baselineHeap),
        responseHeldHeapDeltaBytes: responseHeldHeap - baselineHeap,
        postSendRetainedHeapDeltaBytes: postSendHeap - baselineHeap,
        peakRssDeltaBytes: Math.max(0, peakRss - baselineRss),
        chunks,
        pages,
        patches,
        maxChunkPayloadBytes,
        maxWindowTransportBytes,
    }
}

function numberEnv(name: string) {
    const value = Number(process.env[name])
    if (!Number.isFinite(value) || value <= 0) throw new Error(name + ' must be positive')
    return value
}

function rounded(value: number, digits = 2) {
    return Number(value.toFixed(digits))
}

function median(values: number[]) {
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

function medianResult(runs: UnitResult[]) {
    const first = runs[0]
    const numeric = Object.keys(first).filter(key => typeof (first as any)[key] == 'number')
    const out: any = {
        candidate: first.candidate,
        targetMiB: first.targetMiB,
        runs: runs.length,
    }
    for (const key of numeric) {
        if (key == 'targetMiB') continue
        out[key] = median(runs.map(run => (run as any)[key]))
    }
    return out as UnitResult & {runs: number}
}

function printTable(results: (UnitResult & {runs: number})[]) {
    console.log('\nStore Replay View initial transfer (median of isolated runs)')
    console.log('source | candidate           | initial ms | CPU-probe ms | CPU ms | CPU/wall | wire MiB | heap peak MiB | held MiB | post-GC MiB | RSS peak MiB | chunks/pages')
    for (const result of results) {
        console.log([
            String(result.targetMiB).padStart(6),
            result.candidate.padEnd(19),
            rounded(result.wallMs).toFixed(2).padStart(7),
            rounded(result.cpuProbeWallMs).toFixed(2).padStart(12),
            rounded(result.cpuMs).toFixed(2).padStart(6),
            rounded(result.cpuToWall * 100, 1).toFixed(1).padStart(7) + '%',
            rounded(result.payloadWireBytes / MIB).toFixed(2).padStart(8),
            rounded(result.peakHeapDeltaBytes / MIB).toFixed(2).padStart(13),
            rounded(result.responseHeldHeapDeltaBytes / MIB).toFixed(2).padStart(8),
            rounded(result.postSendRetainedHeapDeltaBytes / MIB).toFixed(2).padStart(11),
            rounded(result.peakRssDeltaBytes / MIB).toFixed(2).padStart(12),
            String(result.chunks).padStart(3) + '/' + String(result.pages),
        ].join(' | '))
    }
}

async function main() {
    if (process.env['STORE_REPLAY_VIEW_BENCH_UNIT'] == '1') {
        const candidate = process.env['STORE_REPLAY_VIEW_BENCH_CANDIDATE'] as tCandidate
        if (!candidates.includes(candidate)) throw new Error('unknown candidate: ' + candidate)
        const result = await runUnit(candidate, numberEnv('STORE_REPLAY_VIEW_BENCH_MIB'))
        console.log(RESULT_MARKER + JSON.stringify(result))
        return
    }

    const runs = Math.max(1, Math.floor(Number(process.env['STORE_REPLAY_VIEW_BENCH_RUNS'] ?? 3)))
    const targets = (process.env['STORE_REPLAY_VIEW_BENCH_TARGETS'] ?? '15,50')
        .split(',')
        .map(value => Number(value.trim()))
    const script = resolvePath(__filename)
    const all: (UnitResult & {runs: number})[] = []
    for (const targetMiB of targets) {
        for (const candidate of candidates) {
            const unitRuns: UnitResult[] = []
            for (let run = 0; run < runs; run++) {
                const child = spawnSync(process.execPath, [
                    '--expose-gc',
                    '--import',
                    'tsx',
                    script,
                ], {
                    cwd: process.cwd(),
                    encoding: 'utf8',
                    maxBuffer: 4 * MIB,
                    env: {
                        ...process.env,
                        STORE_REPLAY_VIEW_BENCH_UNIT: '1',
                        STORE_REPLAY_VIEW_BENCH_CANDIDATE: candidate,
                        STORE_REPLAY_VIEW_BENCH_MIB: String(targetMiB),
                    },
                })
                if (child.status != 0) {
                    throw new Error(
                        candidate + ' ' + targetMiB + ' MiB failed:\n'
                        + child.stdout + '\n' + child.stderr,
                    )
                }
                const line = child.stdout.split(/\r?\n/)
                    .find(value => value.startsWith(RESULT_MARKER))
                if (!line) throw new Error('unit produced no result: ' + child.stdout)
                const result = JSON.parse(line.slice(RESULT_MARKER.length)) as UnitResult
                unitRuns.push(result)
                console.log(
                    `[${targetMiB} MiB] ${candidate} ${run + 1}/${runs}: `
                    + `${rounded(result.wallMs)} ms wall, ${rounded(result.cpuMs)} ms CPU`,
                )
            }
            all.push(medianResult(unitRuns))
        }
    }
    printTable(all)
    console.log('\n' + RESULT_MARKER + JSON.stringify(all))
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
