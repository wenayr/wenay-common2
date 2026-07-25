// =====================================================================
// Artifact mirror: read-edge of replicated catalog on follower node
// =====================================================================
// The artifact catalog reaches the node via normal replay replication (it's a store),
// and this module is the "read edge" on top of it: the same per-account projection and
// the same fragment {state, open, revoke} as in createArtifactHost, only
// there is no authority here. open() after LOCAL authorization is delegated to deps
// (byte cache + local URL delivery), revoke is forwarded to the source of truth.
// Policy is applied AT EACH EDGE: replication of the catalog between nodes is
// a trusted channel, but the end client sees only their own.

import {createStore, Store, StoreChange, StoreDrain} from '../Observe/store'
import {exposeStoreReplay} from '../Observe/store-replay'
import {
    collectStoreProjectionChanges,
    reconcileStoreProjection,
    reconcileStoreProjectionRecord,
} from '../Observe/store-projection'
import {
    ArtifactOpenInstruction,
    ArtifactPolicy,
    ArtifactRecord,
    ArtifactStore,
    copyArtifact,
    validateOpenInstruction,
} from './artifact-host'

export type ArtifactMirrorDeps = {
    /** Mirror catalog (follower store) — source of records, read-only. */
    catalog: Store<ArtifactStore>
    /** Same semantics as host: by default only owner can read/revoke. */
    policy?: Pick<ArtifactPolicy, 'canRead' | 'canRevoke'>
    /** Local delivery of open-instruction AFTER authorization: byte cache → own URL. */
    open: (input: {artifact: ArtifactRecord, account: string}) => Promise<ArtifactOpenInstruction> | ArtifactOpenInstruction
    /** Forward revoke to source of truth; not set — mirror is honestly read-only. */
    revoke?: (account: string, artifactId: string) => Promise<ArtifactRecord> | ArtifactRecord
    history?: number
    drain?: StoreDrain
    now?: () => number
}

export function createArtifactMirror(deps: ArtifactMirrorDeps) {
    const {catalog, policy, history, drain, now = Date.now} = deps
    const views = new Set<{refresh: (change: StoreChange) => void, close: () => void}>()
    let closed = false

    function readable(account: string, artifact: ArtifactRecord) {
        return policy?.canRead ? policy.canRead(account, artifact) : artifact.owner == account
    }

    function revokable(account: string, artifact: ArtifactRecord) {
        return policy?.canRevoke ? policy.canRevoke(account, artifact) : artifact.owner == account
    }

    function project(account: string): ArtifactStore {
        const artifacts: Record<string, ArtifactRecord> = {}
        for (const [id, artifact] of Object.entries(catalog.state.artifacts ?? {})) {
            if (readable(account, artifact)) artifacts[id] = copyArtifact(artifact)
        }
        return {artifacts}
    }

    const offCatalog = catalog.listenPaths().on(function refreshMirrorViews(change) {
        if (closed) return
        for (const view of views) view.refresh(change)
    })

    function isExpired(artifact: ArtifactRecord) {
        return artifact.retention.expiresAt != null && artifact.retention.expiresAt <= now()
    }

    // Requirements are the same as in host.open — error texts match, it is indistinguishable
    // to the client whether they are connected to the leader or the mirror. Invalidation is not our job:
    // an expired mirror only refuses, the leader changes the state (reap).
    function requireReadableReady(account: string, artifactId: string) {
        const artifact = catalog.state.artifacts?.[artifactId]
        if (!artifact || !readable(account, artifact)) throw new Error('artifact open: forbidden or missing')
        if (artifact.state != 'ready') throw new Error('artifact open: artifact is ' + artifact.state)
        if (isExpired(artifact)) throw new Error('artifact open: artifact expired')
        return artifact
    }

    async function open(account: string, artifactId: string) {
        if (closed) throw new Error('artifact mirror closed')
        const artifact = requireReadableReady(account, artifactId)
        const instruction = await deps.open({artifact: copyArtifact(artifact), account})
        return validateOpenInstruction(instruction, now())
    }

    async function revoke(account: string, artifactId: string) {
        if (closed) throw new Error('artifact mirror closed')
        const artifact = catalog.state.artifacts?.[artifactId]
        if (!artifact || !revokable(account, artifact)) throw new Error('artifact revoke: forbidden or missing')
        if (!deps.revoke) throw new Error('artifact revoke: this node is a read-only mirror')
        return deps.revoke(account, artifactId)
    }

    function connection(account: string) {
        if (closed) throw new Error('artifact mirror closed')
        const state = createStore<ArtifactStore>(project(account), drain !== undefined ? {drain} : {})
        const replay = exposeStoreReplay(state, history == undefined ? {} : {history})
        let connectionClosed = false
        const view = {
            refresh: function refreshProjection(change: StoreChange) {
                // A custom policy may close over tenant membership outside the changed record.
                if (policy?.canRead) { reconcileStoreProjection(state, project(account)); return }
                const changed = collectStoreProjectionChanges(change, ['artifacts'])
                if (!changed) { reconcileStoreProjection(state, project(account)); return }
                for (const itemKey of changed.get('artifacts') ?? []) {
                    const id = String(itemKey)
                    const artifact = catalog.state.artifacts[id]
                    const visible = !!artifact && readable(account, artifact)
                    reconcileStoreProjectionRecord(state, 'artifacts', id, {
                        exists: visible,
                        ...(visible ? {value: copyArtifact(artifact!)} : {}),
                    })
                }
            },
            close: function closeConnectionView() {
                if (connectionClosed) return
                connectionClosed = true
                views.delete(view)
                replay.close()
            }
        }
        views.add(view)
        return {
            fragment: {
                state: replay.api.replay,
                open: (artifactId: string) => open(account, artifactId),
                revoke: (artifactId: string) => revoke(account, artifactId),
            },
            close: view.close,
        }
    }

    return {
        connection,
        close() {
            if (closed) return
            closed = true
            offCatalog()
            for (const view of Array.from(views)) view.close()
            views.clear()
        },
    }
}

export type ArtifactMirror = ReturnType<typeof createArtifactMirror>
