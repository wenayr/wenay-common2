// REAL-SOCKET artifact transfer oracle. Каталог артефактов реплицируется на
// узел-зеркало обычным createStoreFollower (это store), байты едут лениво через
// createArtifactByteCache: промах → open у лидера → fetch → sha256-проверка →
// кэш. Политика применяется на каждой кромке: mirror-link видит весь каталог
// (доверенный канал), конечные клиенты — только своё. Тексты ошибок совпадают
// с host — клиенту неразличимо, где он. Порты 3162/3163 (диапазон 3100+).
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createArtifactHost, ArtifactRecord, ArtifactStore} from '../../src/Common/artifact/artifact-host'
import {createArtifactMirror} from '../../src/Common/artifact/artifact-mirror'
import {createArtifactByteCache} from '../../src/Common/artifact/artifact-cache'
import {sha256Hex} from '../../src/Common/artifact/artifact-hash'
import {createStoreFollower} from '../../src/Common/Observe/store-follower'
import {StorePatch} from '../../src/Common/Observe/store'
import {ReplayRemote} from '../../src/Common/events/replay-wire'

const LEADER_PORT = 3162
const MIRROR_PORT = 3163
const MIRROR_ACCOUNT = 'mirror-link'

async function rejectionText(work: () => Promise<any>) {
    try {
        await work()
        return null
    } catch (error: any) {
        return typeof error?.message == 'string' ? error.message : String(error)
    }
}

async function waitFor(name: string, predicate: () => boolean, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try { if (predicate()) return } catch {}
        await delay(10)
    }
    throw new Error('timeout waiting for ' + name)
}

async function main() {
    const {check, done} = makeChecker('artifact-mirror')
    const watchdog = setTimeout(function specTimedOut() {
        console.error('artifact-mirror oracle timed out')
        process.exit(3)
    }, 120000)

    // ============== лидер: авторитетный каталог + байты в Map + data:-URL ==============
    const leaderBytes = new Map<string, string>()
    let fetches = 0
    const host = createArtifactHost({
        storage: {
            open({storageKey}) {
                // data:-URL абсолютен и фетчится нодой — ораклу не нужен HTTP-порт раздачи
                const html = leaderBytes.get(String(storageKey)) ?? ''
                return {url: 'data:text/html;base64,' + Buffer.from(html).toString('base64'), expiresAt: Date.now() + 60_000}
            },
        },
        // Кромка доверия: mirror-link читает весь каталог и проводит форварды;
        // авторизацию КОНЕЧНОГО клиента уже сделало зеркало на своей кромке.
        policy: {
            canRead: (account, artifact) => account == MIRROR_ACCOUNT || artifact.owner == account,
            canRevoke: (account, artifact) => account == MIRROR_ACCOUNT || artifact.owner == account,
        },
    })

    async function registerOnLeader(owner: string, html: string, label: string) {
        const key = 'bytes-' + label
        leaderBytes.set(key, html)
        return host.register({
            owner,
            descriptor: {kind: 'demo', label, runtime: 'sandboxed-iframe', mime: 'text/html', version: await sha256Hex(html)},
            storageKey: key,
            retention: {class: 'persistent'},
        })
    }

    const htmlA = '<!doctype html><h1>artifact of person-a</h1>'
    const first = await registerOnLeader('person-a', htmlA, 'first')

    let leaderConn = 0
    const leaderSrv = await startRealServer({
        port: LEADER_PORT,
        makeObject: function makeLeaderConnection() {
            const account = leaderConn++ == 0 ? MIRROR_ACCOUNT : 'person-' + leaderConn
            const connection = host.connection(account)
            return {whoami: () => account, artifacts: connection.fragment}
        },
    })

    // ============== узел-зеркало: каталог-фолловер + байт-кэш + read-edge ==============
    const upstream = await startRealClient({port: LEADER_PORT})   // первый коннект = mirror-link
    const catalog = createStoreFollower<ArtifactStore>({
        remote: upstream.api.artifacts.state as ReplayRemote<[StorePatch]>,
        initial: {artifacts: {}},
    })
    const cache = createArtifactByteCache({
        async fetch(artifact: ArtifactRecord) {
            fetches++
            const instruction = await upstream.api.artifacts.open(artifact.id)
            const response = await fetch(instruction.url)
            return await response.text()
        },
    })
    const served = new Map<string, string>()
    const mirror = createArtifactMirror({
        catalog: catalog.store,
        async open({artifact}) {
            const {hash, bytes} = await cache.get(artifact)
            served.set(hash, String(bytes))
            return {url: 'data:text/html;base64,' + Buffer.from(String(bytes)).toString('base64'), expiresAt: Date.now() + 60_000}
        },
        async revoke(_account, artifactId) {
            // форвард источнику истины: авторизация конечного клиента уже пройдена локально
            return await upstream.api.artifacts.revoke(artifactId)
        },
    })
    let mirrorConn = 0
    const mirrorSrv = await startRealServer({
        port: MIRROR_PORT,
        makeObject: function makeMirrorConnection() {
            const account = 'person-' + String.fromCharCode(97 + mirrorConn++)   // person-a, person-b...
            const connection = mirror.connection(account)
            return {whoami: () => account, artifacts: connection.fragment}
        },
    })

    await catalog.ready
    await check('catalog mirrored to the follower node', () => catalog.store.state.artifacts[first.id]?.descriptor.label, 'first')

    // ============== клиенты зеркала: политика на кромке + ленивые байты ==============
    const a = await startRealClient({port: MIRROR_PORT})   // person-a (владелец)
    const b = await startRealClient({port: MIRROR_PORT})   // person-b (чужой)

    const openedByA = await a.api.artifacts.open(first.id)
    const fetched = await fetch(openedByA.url)
    await check('owner opens through the mirror and gets the exact bytes', () => fetched.text(), htmlA)
    await check('bytes travelled once (lazy fetch on miss)', () => fetches, 1)
    await a.api.artifacts.open(first.id)
    await check('second open is a cache hit (no new fetch)', () => fetches, 1)
    await check('cache stats count the hit', () => cache.stats().hits >= 1 && cache.stats().entries == 1, true)

    await check('stranger cannot open through the mirror',
        () => rejectionText(() => Promise.resolve(b.api.artifacts.open(first.id))), 'artifact open: forbidden or missing')

    // ============== целостность: битые байты не проходят hash-проверку ==============
    const evil = '<!doctype html><script>alert("swapped")</script>'
    const second = await registerOnLeader('person-a', '<!doctype html><p>honest</p>', 'second')
    leaderBytes.set('bytes-second', evil)   // подмена содержимого ПОСЛЕ регистрации
    await waitFor('tampered artifact reaches the catalog', () => catalog.store.state.artifacts[second.id] != null)
    const tampered = await rejectionText(() => Promise.resolve(a.api.artifacts.open(second.id)))
    await check('tampered bytes fail the integrity check', () => tampered?.includes('integrity check failed'), true)

    // ============== revoke сквозь зеркало: форвард + реактивная инвалидация ==============
    const revoked = await a.api.artifacts.revoke(first.id)
    await check('revoke forwarded to the leader', () => revoked.state, 'revoked')
    await waitFor('revocation mirrors back', () => catalog.store.state.artifacts[first.id]?.state == 'revoked')
    await check('revoked artifact refuses to open on the mirror',
        () => rejectionText(() => Promise.resolve(a.api.artifacts.open(first.id))), 'artifact open: artifact is revoked')
    await check('stranger cannot revoke through the mirror',
        () => rejectionText(() => Promise.resolve(b.api.artifacts.revoke(second.id))), 'artifact revoke: forbidden or missing')

    // ============== артефакт без content-hash версии не передаётся ==============
    leaderBytes.set('bytes-legacy', '<p>legacy</p>')
    const legacy = host.register({
        owner: 'person-a',
        descriptor: {kind: 'demo', label: 'legacy', runtime: 'sandboxed-iframe', version: '1'},
        storageKey: 'bytes-legacy',
        retention: {class: 'persistent'},
    })
    await waitFor('legacy artifact reaches the catalog', () => catalog.store.state.artifacts[legacy.id] != null)
    const noHash = await rejectionText(() => Promise.resolve(a.api.artifacts.open(legacy.id)))
    await check('artifacts without a content hash are refused by the transfer', () => noHash?.includes('content hash'), true)

    // ============== teardown ==============
    a.close()
    b.close()
    mirror.close()
    catalog.close()
    upstream.close()
    host.close()
    await mirrorSrv.close()
    await leaderSrv.close()
    clearTimeout(watchdog)
    process.exit(done() == 0 ? 0 : 1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
