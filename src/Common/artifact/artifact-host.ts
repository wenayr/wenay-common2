// =====================================================================
// Artifact host — private storage keys + authorized descriptor replay
// =====================================================================
// The Store carries only small lifecycle descriptors. Storage owns bytes and
// short-lived read instructions; the private provider key never crosses RPC.

import {createStore, StoreDrain} from '../Observe/store'
import {exposeStoreReplay} from '../Observe/store-replay'

export type ArtifactRuntime = 'sandboxed-iframe' | 'download'
export type ArtifactState = 'ready' | 'revoked' | 'expired'
export type ArtifactRetention =
    | {class: 'ephemeral', expiresAt: number}
    | {class: 'persistent', expiresAt?: number}

export type ArtifactDescriptor = {
    kind: string
    label: string
    runtime: ArtifactRuntime
    mime?: string
    version?: string
}

export type ArtifactRecord = {
    id: string
    owner: string
    descriptor: ArtifactDescriptor
    state: ArtifactState
    retention: ArtifactRetention
    createdAt: number
    updatedAt: number
}

export type ArtifactStore = {
    artifacts: Record<string, ArtifactRecord>
}

export type ArtifactOpenInstruction = {
    /** An absolute, short-lived URL from the storage adapter. Never Store state. */
    url: string
    expiresAt: number
}

export type ArtifactStoragePort = {
    /** Issue an authorized read instruction for one account, using a private provider key. */
    open(input: {artifact: ArtifactRecord, storageKey: unknown, account: string}): ArtifactOpenInstruction | Promise<ArtifactOpenInstruction>
    /** Optional physical deletion/tombstone hook after the artifact is no longer openable. */
    remove?(input: {artifact: ArtifactRecord, storageKey: unknown, reason: 'revoked' | 'expired'}): void | Promise<void>
}

export type ArtifactRegisterInput = {
    owner: string
    descriptor: ArtifactDescriptor
    /** Server-side provider key only. It is held outside the Store and RPC projection. */
    storageKey: unknown
    /** Ephemeral artifacts must declare their expiry; persistent retention is explicit. */
    retention: ArtifactRetention
}

export type ArtifactPolicy = {
    /** Default: only the owner sees a descriptor or receives a read instruction. */
    canRead?: (account: string, artifact: ArtifactRecord) => boolean
    /** Default: only the owner may revoke a ready artifact. */
    canRevoke?: (account: string, artifact: ArtifactRecord) => boolean
    /** Server-side quota/tenant policy before a trusted runner registers a descriptor. */
    canRegister?: (input: ArtifactRegisterInput) => boolean
}

export type ArtifactHostDeps = {
    storage: ArtifactStoragePort
    policy?: ArtifactPolicy
    id?: () => string
    now?: () => number
    history?: number
    drain?: StoreDrain
}

type ArtifactView = {
    refresh: () => void
    close: () => void
}

function copyDescriptor(descriptor: ArtifactDescriptor): ArtifactDescriptor {
    return {...descriptor}
}

function copyRetention(retention: ArtifactRetention): ArtifactRetention {
    return {...retention}
}

function copyArtifact(artifact: ArtifactRecord): ArtifactRecord {
    return {...artifact, descriptor: copyDescriptor(artifact.descriptor), retention: copyRetention(artifact.retention)}
}

function validateDescriptor(descriptor: ArtifactDescriptor) {
    if (!descriptor || typeof descriptor.kind != 'string' || !descriptor.kind.trim()) throw new Error('artifact register: descriptor kind is required')
    if (typeof descriptor.label != 'string' || !descriptor.label.trim()) throw new Error('artifact register: descriptor label is required')
    if (descriptor.runtime != 'sandboxed-iframe' && descriptor.runtime != 'download') throw new Error('artifact register: unsupported runtime')
}

function validateRetention(retention: ArtifactRetention, now: number) {
    if (retention.class != 'ephemeral' && retention.class != 'persistent') throw new Error('artifact register: invalid retention class')
    if (retention.class == 'ephemeral' && retention.expiresAt == null) throw new Error('artifact register: ephemeral expiry is required')
    if (retention.expiresAt != null && (!Number.isFinite(retention.expiresAt) || retention.expiresAt <= now)) {
        throw new Error('artifact register: expiry must be in the future')
    }
}

function validateOpenInstruction(instruction: ArtifactOpenInstruction, now: number) {
    if (!instruction || typeof instruction.url != 'string' || !instruction.url) throw new Error('artifact storage: URL is required')
    if (!Number.isFinite(instruction.expiresAt) || instruction.expiresAt <= now) throw new Error('artifact storage: open instruction is already expired')
    try { new URL(instruction.url) }
    catch { throw new Error('artifact storage: URL must be absolute') }
    return {...instruction}
}

export function createArtifactHost(deps: ArtifactHostDeps) {
    const {storage, policy, history, drain, now = Date.now} = deps
    let nextId = 0
    const makeId = deps.id ?? function defaultId() { return 'artifact-' + (++nextId) }
    const store = createStore<ArtifactStore>({artifacts: {}}, drain !== undefined ? {drain} : {})
    const storageKeys = new Map<string, unknown>()
    const views = new Set<ArtifactView>()
    let closed = false

    // === Business policy ===

    function readable(account: string, artifact: ArtifactRecord) {
        return policy?.canRead ? policy.canRead(account, artifact) : artifact.owner == account
    }

    function revokable(account: string, artifact: ArtifactRecord) {
        return policy?.canRevoke ? policy.canRevoke(account, artifact) : artifact.owner == account
    }

    function project(account: string): ArtifactStore {
        const artifacts: Record<string, ArtifactRecord> = {}
        for (const [id, artifact] of Object.entries(store.state.artifacts)) {
            if (readable(account, artifact)) artifacts[id] = copyArtifact(artifact)
        }
        return {artifacts}
    }

    function refreshViews() {
        if (closed) return
        for (const view of views) view.refresh()
    }

    const offStore = store.listenPaths().on(refreshViews)

    function createView(account: string) {
        const state = createStore<ArtifactStore>(project(account), drain !== undefined ? {drain} : {})
        const replay = exposeStoreReplay(state, history !== undefined ? {history} : {})
        let view: ArtifactView
        view = {
            refresh() { state.replace(project(account)) },
            close() {
                views.delete(view)
                replay.close()
            },
        }
        return {view, replay}
    }

    function touch(artifact: ArtifactRecord) {
        artifact.updatedAt = now()
    }

    function isExpired(artifact: ArtifactRecord, at = now()) {
        return artifact.retention.expiresAt != null && artifact.retention.expiresAt <= at
    }

    async function removeStorage(artifact: ArtifactRecord, reason: Extract<ArtifactState, 'revoked' | 'expired'>) {
        const storageKey = storageKeys.get(artifact.id)
        if (storageKey === undefined) return
        // Keep the private key on failure so a later revoke/reap can reconcile storage.
        await storage.remove?.({artifact: copyArtifact(artifact), storageKey, reason})
        storageKeys.delete(artifact.id)
    }

    async function invalidate(artifact: ArtifactRecord, state: Extract<ArtifactState, 'revoked' | 'expired'>) {
        if (artifact.state == 'ready') {
            artifact.state = state
            touch(artifact)
        }
        if (artifact.state != state) return copyArtifact(artifact)
        await removeStorage(artifact, state)
        return copyArtifact(artifact)
    }

    async function requireReadableReady(account: string, artifactId: string) {
        const artifact = store.state.artifacts[artifactId]
        if (!artifact || !readable(account, artifact)) throw new Error('artifact open: forbidden or missing')
        if (artifact.state != 'ready') throw new Error('artifact open: artifact is ' + artifact.state)
        if (isExpired(artifact)) {
            await invalidate(artifact, 'expired')
            throw new Error('artifact open: artifact expired')
        }
        return artifact
    }

    // === Server authority ===

    function register(input: ArtifactRegisterInput) {
        if (closed) throw new Error('artifact host closed')
        if (!input || typeof input.owner != 'string' || !input.owner) throw new Error('artifact register: owner is required')
        if (input.storageKey === undefined) throw new Error('artifact register: storageKey is required')
        validateDescriptor(input.descriptor)
        const retention = input.retention
        validateRetention(retention, now())
        if (policy?.canRegister && !policy.canRegister(input)) throw new Error('artifact register: forbidden')
        const createdAt = now()
        const artifact: ArtifactRecord = {
            id: makeId(),
            owner: input.owner,
            descriptor: copyDescriptor(input.descriptor),
            state: 'ready',
            retention: copyRetention(retention),
            createdAt,
            updatedAt: createdAt,
        }
        storageKeys.set(artifact.id, input.storageKey)
        store.state.artifacts[artifact.id] = artifact
        return copyArtifact(artifact)
    }

    async function open(account: string, artifactId: string) {
        if (closed) throw new Error('artifact host closed')
        const artifact = await requireReadableReady(account, artifactId)
        const storageKey = storageKeys.get(artifact.id)
        if (storageKey === undefined) throw new Error('artifact open: storage key is unavailable')
        const instruction = await storage.open({artifact: copyArtifact(artifact), storageKey, account})
        return validateOpenInstruction(instruction, now())
    }

    async function revoke(account: string, artifactId: string) {
        if (closed) throw new Error('artifact host closed')
        const artifact = store.state.artifacts[artifactId]
        if (!artifact || !revokable(account, artifact)) throw new Error('artifact revoke: forbidden or missing')
        return invalidate(artifact, 'revoked')
    }

    async function reap(at = now()) {
        const reaped: ArtifactRecord[] = []
        for (const artifact of Object.values(store.state.artifacts)) {
            const shouldExpire = artifact.state == 'ready' && isExpired(artifact, at)
            const retryRemoval = (artifact.state == 'expired' || artifact.state == 'revoked') && storageKeys.has(artifact.id)
            if (!shouldExpire && !retryRemoval) continue
            const state = artifact.state == 'revoked' ? 'revoked' : 'expired'
            reaped.push(await invalidate(artifact, state))
        }
        return reaped
    }

    function connection(account: string) {
        if (closed) throw new Error('artifact host closed')
        const {view, replay} = createView(account)
        views.add(view)
        let connectionClosed = false
        return {
            fragment: {
                state: replay.api.replay,
                open: (artifactId: string) => open(account, artifactId),
                revoke: (artifactId: string) => revoke(account, artifactId),
            },
            close() {
                if (connectionClosed) return
                connectionClosed = true
                view.close()
            },
        }
    }

    return {
        register,
        reap,
        connection,
        /** Server-only authority. Expose only the account-filtered connection fragment over RPC. */
        store,
        close() {
            if (closed) return
            closed = true
            offStore()
            for (const view of Array.from(views)) view.close()
            storageKeys.clear()
        },
    }
}

export type ArtifactHost = ReturnType<typeof createArtifactHost>
