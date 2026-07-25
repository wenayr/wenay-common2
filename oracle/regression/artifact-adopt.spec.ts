// Oracle: artifact catalog failover tail — adopt a promoted mirror's catalog into a new host.
// createArtifactHost({store}) continues the artifact-N id line (no re-issued ids) and
// recovers private keys through storage.adoptKey (content-hash version → local byte cache).
// In-proc replay wire; disposable oracle, run through tsx.

import {createArtifactHost, ArtifactRecord, ArtifactStore} from '../../src/Common/artifact/artifact-host'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {StorePatch} from '../../src/Common/Observe/store'
import {ReplayRemote} from '../../src/Common/events/replay-wire'

let failures = 0
const ok = (condition: any, message: string) => {
    if (!condition) { failures++; console.log('FAIL', message) }
    else console.log('PASS', message)
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function rejection(fn: () => Promise<any>) {
    try { await fn(); return null } catch (e: any) { return String(e?.message ?? e) }
}

async function main() {
    const policy = {
        canRead: (account: string, artifact: ArtifactRecord) => account == 'mirror' || artifact.owner == account,
        canRevoke: (account: string, artifact: ArtifactRecord) => account == 'mirror' || artifact.owner == account,
    }

    // === lifetime 1: the leader registers two artifacts (one carries a content-hash version) ===
    const leader = createArtifactHost({
        storage: {open: ({storageKey}) => ({url: 'https://leader/' + String(storageKey), expiresAt: Date.now() + 60_000})},
        policy,
    })
    const first = leader.register({
        owner: 'alice',
        descriptor: {kind: 'demo', label: 'first', runtime: 'download', version: 'hash-one'},
        storageKey: 'k1',
        retention: {class: 'persistent'},
    })
    const second = leader.register({
        owner: 'alice',
        descriptor: {kind: 'demo', label: 'second', runtime: 'download'},
        storageKey: 'k2',
        retention: {class: 'persistent'},
    })
    ok(first.id == 'artifact-1' && second.id == 'artifact-2', 'leader issued artifact-1/artifact-2')

    // === mirror-link: catalog follower over the per-account view (in-proc replay wire) ===
    const link = leader.connection('mirror')
    const follower = createStoreFollower<ArtifactStore>({
        remote: link.fragment.state as unknown as ReplayRemote<[StorePatch]>,
        initial: {artifacts: {}},
    })
    await follower.ready
    await tick()
    ok(Object.keys(follower.store.state.artifacts ?? {}).length == 2, 'mirror caught the full catalog')

    // === failover: promote the mirror, adopt its catalog into a NEW host on this node ===
    follower.promote()
    const localBytes = new Map<string, string>([['hash-one', 'payload-one']])   // byte cache keyed by content hash
    const adopted = createArtifactHost({
        store: follower.store,
        storage: {
            open: ({storageKey}) => ({url: 'https://mirror/' + String(storageKey), expiresAt: Date.now() + 60_000}),
            adoptKey: artifact => artifact.descriptor.version != null && localBytes.has(artifact.descriptor.version)
                ? artifact.descriptor.version : undefined,
        },
        policy,
    })

    // id line continues: the new authority never re-issues a taken artifact-N
    const third = adopted.register({
        owner: 'alice',
        descriptor: {kind: 'demo', label: 'third', runtime: 'download'},
        storageKey: 'k3',
        retention: {class: 'persistent'},
    })
    ok(third.id == 'artifact-3', 'adopted host continues the id line, got ' + third.id)

    const conn = adopted.connection('alice')
    const opened = await conn.fragment.open(first.id)
    ok(opened.url == 'https://mirror/hash-one', 'adopted artifact opens from the local byte cache')

    const refused = await rejection(() => Promise.resolve(conn.fragment.open(second.id)))
    ok(refused != null && refused.includes('storage key is unavailable'), 'unrecoverable key refuses loudly: ' + refused)

    const openedThird = await conn.fragment.open(third.id)
    ok(openedThird.url == 'https://mirror/k3', 'new registration opens through the adopted host')

    conn.close(); adopted.close(); follower.close(); link.close(); leader.close()
    console.log(failures ? `artifact-adopt: ${failures} FAILED` : 'artifact-adopt: ALL GREEN')
    process.exit(failures ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
