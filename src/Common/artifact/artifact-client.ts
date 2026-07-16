// =====================================================================
// Artifact client — local descriptor mirror + explicit open/revoke calls
// =====================================================================

import {createStore, StoreDrain} from '../Observe/store'
import {syncStoreReplay} from '../Observe/store-replay'
import {ReplayRemote} from '../events/replay-wire'
import {ArtifactOpenInstruction, ArtifactRecord, ArtifactStore} from './artifact-host'

export type ArtifactRemote = {
    state: ReplayRemote<any>
    open: (artifactId: string) => ArtifactOpenInstruction | Promise<ArtifactOpenInstruction>
    revoke: (artifactId: string) => ArtifactRecord | Promise<ArtifactRecord>
}

export type ArtifactClientDeps = {
    /** Deep proxy of `host.connection(account).fragment` on the existing RPC connection. */
    remote: ArtifactRemote
    initial?: ArtifactStore
    drain?: StoreDrain
}

export function createArtifactClient(deps: ArtifactClientDeps) {
    const {remote, initial = {artifacts: {}}, drain} = deps
    const store = createStore<ArtifactStore>(initial, drain !== undefined ? {drain} : {})
    const sync = syncStoreReplay(store, remote.state)

    async function open(artifactId: string) {
        return remote.open(artifactId)
    }

    async function revoke(artifactId: string) {
        return remote.revoke(artifactId)
    }

    return {
        /** Account-filtered artifact descriptors; never storage keys, bytes or signed URLs. */
        store,
        ready: sync.ready,
        seq: sync.seq,
        open,
        revoke,
        close() { sync() },
    }
}

export type ArtifactClient = ReturnType<typeof createArtifactClient>
