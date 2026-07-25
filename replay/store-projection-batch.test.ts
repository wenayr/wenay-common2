// Projected account Stores: equal projections stay silent and visible bursts batch.

import {ArtifactStore, createArtifactHost} from '../src/Common/artifact/artifact-host'
import {createArtifactMirror} from '../src/Common/artifact/artifact-mirror'
import {createStore, listenStorePatches} from '../src/Common/Observe/store'
import {reconcileStoreProjection, reconcileStoreProjectionRecord} from '../src/Common/Observe/store-projection'
import {flushReactive} from '../src/Common/Observe/reactive'
import {syncStoreReplay} from '../src/Common/Observe/store-replay'
import {decodeStoreReplayBatchV2} from '../src/Common/Observe/store-replay-codec'
import {createFileJobHost} from '../src/Common/resource/file-job-host'

let fails = 0
function ok(condition: any, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function drainTurn() {
    await new Promise<void>(function waitForDrain(resolve) { setImmediate(resolve) })
}

async function main() {
    console.log('\n[store-projection-batch] silent unrelated views + compact visible bursts')

    const projected = createStore({items: {a: {value: 1}}, flags: {ready: {value: true}}}, {drain: 'micro'})
    const batches: any[][] = []
    const offProjected = listenStorePatches(projected).on(function rememberProjectionBatch(patches) { batches.push(patches) })
    const equalWrites = reconcileStoreProjection(projected, {items: {a: {value: 1}}, flags: {ready: {value: true}}})
    await flushReactive(projected.state)
    ok(equalWrites == 0 && batches.length == 0, 'structurally equal fresh projection writes and emits nothing')

    const changedWrites = reconcileStoreProjection(projected, {
        items: {a: {value: 2}, b: {value: 3}},
        flags: {ready: {value: true}},
    })
    await flushReactive(projected.state)
    ok(changedWrites == 2 && batches.length == 1 && batches[0].length == 2,
        'only changed records enter one natural Store batch')
    ok(batches[0].every(patch => patch.path[0] == 'items' && patch.path.length == 2),
        'projection keeps record-level paths instead of replacing the full map')
    offProjected()

    const typedProjection = createStore<{items: Record<string, number | string>}>({items: {a: 1}})
    const typedWrites = reconcileStoreProjection(typedProjection, {items: {a: '1'}})
    ok(typedWrites == 1 && typeof typedProjection.state.items.a == 'string',
        'projection reconciliation keeps same-value type changes despite legacy deepEqual coercion')

    const keyedProjection = createStore<any>({items: {}})
    const dangerousItems = Object.create(null)
    Object.defineProperty(dangerousItems, '__proto__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {value: 1},
    })
    const dangerousWrites = reconcileStoreProjection(keyedProjection, {items: dangerousItems})
    const recordWrite = reconcileStoreProjectionRecord(
        keyedProjection,
        'items',
        '__proto__',
        {exists: true, value: {value: 2}},
    )
    const keyedSnapshot = keyedProjection.snapshot()
    ok(dangerousWrites == 1 && recordWrite
        && Object.prototype.hasOwnProperty.call(keyedSnapshot.items, '__proto__')
        && keyedSnapshot.items['__proto__'].value == 2
        && Object.getPrototypeOf(keyedSnapshot.items) == Object.prototype,
    'full and record projection paths preserve __proto__ as own Store data without changing prototypes')

    const host = createArtifactHost({
        storage: {open: () => ({url: 'https://artifact.example/item', expiresAt: Date.now() + 1_000})},
        drain: 'micro',
    })
    const owner = host.connection('owner')
    const stranger = host.connection('stranger')
    const ownerBatches: any[] = []
    let strangerBatches = 0
    const offOwner = owner.fragment.state.line.on(function rememberOwnerBatch(batch: any) { ownerBatches.push(batch) })
    const offStranger = stranger.fragment.state.line.on(function countStrangerBatch() { strangerBatches++ })

    host.register({
        owner: 'owner',
        descriptor: {kind: 'report', label: 'One', runtime: 'download'},
        storageKey: 'one',
        retention: {class: 'persistent'},
    })
    host.register({
        owner: 'owner',
        descriptor: {kind: 'report', label: 'Two', runtime: 'download'},
        storageKey: 'two',
        retention: {class: 'persistent'},
    })
    await flushReactive(host.store.state)
    await drainTurn()

    ok(ownerBatches.length == 1 && ownerBatches[0][3].length == 2,
        'two visible records from one source drain travel in one compact batch')
    ok(strangerBatches == 0, 'an unrelated account receives no V2 projection traffic')

    offOwner()
    offStranger()
    owner.close()
    stranger.close()
    host.close()

    let grant = true
    const policyHost = createArtifactHost({
        storage: {open: () => ({url: 'https://artifact.example/policy', expiresAt: Date.now() + 1_000})},
        policy: {canRead: () => grant},
        drain: 'micro',
    })
    const first = policyHost.register({
        owner: 'owner', descriptor: {kind: 'report', label: 'First', runtime: 'download'},
        storageKey: 'first', retention: {class: 'persistent'},
    })
    policyHost.register({
        owner: 'owner', descriptor: {kind: 'report', label: 'Second', runtime: 'download'},
        storageKey: 'second', retention: {class: 'persistent'},
    })
    await flushReactive(policyHost.store.state)
    const policyView = policyHost.connection('viewer')
    const policyBatches: any[] = []
    const offPolicyBatch = policyView.fragment.state.line.on(function rememberPolicyBatch(batch: any) {
        policyBatches.push(batch)
    })
    grant = false
    policyHost.store.state.artifacts[first.id].updatedAt++
    await flushReactive(policyHost.store.state)
    await drainTurn()
    const policyFrame = await policyView.fragment.state.keyframe()
    const policyDeletes = policyBatches.flatMap(decodeStoreReplayBatchV2)
        .flatMap(event => event.event[0]).filter(patch => !patch.exists)
    const decodedPolicyFrame = decodeStoreReplayBatchV2(policyFrame)
    ok(Object.keys((decodedPolicyFrame as any).event[0][0].value.artifacts).length == 0,
        'custom policy invalidation rechecks the complete projection')
    ok(policyBatches.length == 1 && policyDeletes.length == 2,
        'one policy change removes every newly forbidden record in one batch')
    offPolicyBatch()
    policyView.close()
    policyHost.close()

    const mirrorCatalog = createStore<ArtifactStore>({artifacts: {}})
    const artifactMirror = createArtifactMirror({
        catalog: mirrorCatalog,
        open: () => ({url: 'https://artifact.example/mirror', expiresAt: Date.now() + 1_000}),
    })
    const mirrorConnection = artifactMirror.connection('owner')
    const mirrorState = mirrorConnection.fragment.state as any
    let mirrorLineClosed = false
    mirrorState.line.onClose(function rememberMirrorLineClose() { mirrorLineClosed = true })
    artifactMirror.close()
    let mirrorConnectionRejected = false
    try { artifactMirror.connection('late') } catch { mirrorConnectionRejected = true }
    ok(mirrorLineClosed && mirrorConnectionRejected,
        'artifact mirror close retires its V2 replay view and remains terminal')
    mirrorConnection.close()

    const fileHost = createFileJobHost({
        storage: {beginUpload: () => ({})},
        runner: {run: () => {}},
        drain: 'micro',
    })
    fileHost.store.state.files.f = {
        id: 'f', owner: 'owner', name: 'file', size: 1, state: 'uploaded', createdAt: 1, updatedAt: 1,
    }
    fileHost.store.state.jobs.j = {
        id: 'j', fileId: 'f', owner: 'owner', state: 'ready', progress: 1,
        result: {x: 1}, createdAt: 1, updatedAt: 1,
    }
    await flushReactive(fileHost.store.state)
    const fileView = fileHost.connection('owner')
    const fileMirror = createStore<any>({files: {}, jobs: {}}, {drain: 'micro'})
    const fileSync = syncStoreReplay(fileMirror, fileView.fragment.state as any)
    await fileSync.ready
    const fileBatches: any[] = []
    const offFileBatch = fileView.fragment.state.line.on(function rememberFileBatch(event: any) { fileBatches.push(event) })
    const nestedResult = fileHost.store.state.jobs.j.result as any
    nestedResult.x = 2
    await flushReactive(fileHost.store.state)
    await drainTurn()
    const decodedFileBatch = fileBatches.flatMap(decodeStoreReplayBatchV2)
    ok(decodedFileBatch.length == 1 && decodedFileBatch[0].event[0][0].path.join('/') == 'jobs/j'
        && decodedFileBatch[0].event[0][0].value.result.x == 2,
    'opaque nested changes produce one detached record patch')
    ok(decodedFileBatch.length == 1 && decodedFileBatch[0].event[0].length == 1
        && fileMirror.state.jobs.j.result.x == 2,
    'nested projected data reaches the live batch mirror without waiting for a keyframe')
    offFileBatch()
    fileSync()
    fileView.close()
    fileHost.close()

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
