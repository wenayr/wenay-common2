// =====================================================================
// Артефакт-зеркало: read-edge реплицированного каталога на узле-фолловере
// =====================================================================
// Каталог артефактов доезжает до узла обычной replay-репликацией (это store),
// а этот модуль — «кромка чтения» поверх него: та же per-account проекция и
// тот же фрагмент {state, open, revoke}, что у createArtifactHost, только
// авторитета здесь нет. open() после ЛОКАЛЬНОЙ авторизации делегируется deps
// (байт-кэш + локальная выдача URL), revoke форвардится источнику истины.
// Политика применяется НА КАЖДОЙ кромке: репликация каталога между узлами —
// доверенный канал, но конечный клиент видит только своё.

import {createStore, Store, StoreDrain} from '../Observe/store'
import {exposeStoreReplay} from '../Observe/store-replay'
import {
    ArtifactOpenInstruction,
    ArtifactPolicy,
    ArtifactRecord,
    ArtifactStore,
    copyArtifact,
    validateOpenInstruction,
} from './artifact-host'

export type ArtifactMirrorDeps = {
    /** Зеркальный каталог (store фолловера) — источник записей, read-only. */
    catalog: Store<ArtifactStore>
    /** Та же семантика, что у host: по умолчанию видит/отзывает только владелец. */
    policy?: Pick<ArtifactPolicy, 'canRead' | 'canRevoke'>
    /** Локальная выдача open-инструкции ПОСЛЕ авторизации: кэш байтов → свой URL. */
    open: (input: {artifact: ArtifactRecord, account: string}) => Promise<ArtifactOpenInstruction> | ArtifactOpenInstruction
    /** Форвард revoke источнику истины; не задан — зеркало честно read-only. */
    revoke?: (account: string, artifactId: string) => Promise<ArtifactRecord> | ArtifactRecord
    history?: number
    drain?: StoreDrain
    now?: () => number
}

export function createArtifactMirror(deps: ArtifactMirrorDeps) {
    const {catalog, policy, history, drain, now = Date.now} = deps
    const views = new Set<{refresh: () => void}>()
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

    const offCatalog = catalog.listenPaths().on(function refreshMirrorViews() {
        if (closed) return
        for (const view of views) view.refresh()
    })

    function isExpired(artifact: ArtifactRecord) {
        return artifact.retention.expiresAt != null && artifact.retention.expiresAt <= now()
    }

    // Требования те же, что у host.open — тексты ошибок совпадают, клиенту
    // неразличимо, к лидеру он подключён или к зеркалу. Инвалидация — не наша:
    // истёкшее зеркало только отказывает, состояние меняет лидер (reap).
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
        const replay = exposeStoreReplay(state, history !== undefined ? {history} : {})
        const view = {refresh: function refreshProjection() { state.replace(project(account)) }}
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
                views.delete(view)
                replay.close()
            },
        }
    }

    return {
        connection,
        close() {
            if (closed) return
            closed = true
            offCatalog()
            views.clear()
        },
    }
}

export type ArtifactMirror = ReturnType<typeof createArtifactMirror>
