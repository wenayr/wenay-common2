// Demo stand server: the Peer SDK next to a legacy rpc key, static page hosting.
// Run: npm run demo  ->  open the two printed URLs in two tabs.
import express from 'express'
import {createServer} from 'http'
import path from 'path'
import {Server as SocketIOServer} from 'socket.io'
import {listen} from '../src/Common/events/Listen'
import {SignalEnvelope} from '../src/Common/events/route-signal-webrtc'
import {createMediaRelay, createPeerHost} from '../src/Common/peer/peer-index'
import {createFileJobHost} from '../src/Common/resource/resource-index'
import {createAiRunHost} from '../src/Common/ai/ai-index'
import {createArtifactHost} from '../src/Common/artifact/artifact-index'
import {createConversationHost} from '../src/Common/conversation/conversation-index'
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'
import {io as ioClient} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createArtifactByteCache, createArtifactMirror, sha256Hex} from '../src/Common/artifact/artifact-index'
import type {ArtifactRecord, ArtifactStore} from '../src/Common/artifact/artifact-index'
import {createWorkboardHost, WorkboardHost} from './workboard-host'
import type {WorkboardState} from './workboard-contract'

const portStart = Number(process.env.DEMO_PORT_START ?? 3100)
const portEnd = Number(process.env.DEMO_PORT_END ?? 3500)
const listenHost = process.env.DEMO_HOST
let port = portStart

// ============== instance role: standalone leader or a mirror of another stand ==============
// DEMO_MIRROR_OF=http://localhost:3100 turns this instance into a follower: the
// workboard store is mirrored from the leader over the ordinary replay wire and
// commands are forwarded with the end client's account — receipts and ordering
// stay on the leader (single point of order, see doc/target/store-mirror-plan.md).
const mirrorOf = process.env.DEMO_MIRROR_OF?.trim() || null
// Mirror participants get their own letter namespace (person-za, person-zb, ...)
// so the shared board never shows two different people as the same "Participant A".
const accountPrefix = (process.env.DEMO_ACCOUNT_PREFIX ?? (mirrorOf ? 'z' : '')).trim().toLowerCase()
// Эпоха линии (fork-choice при failover): у самостоятельного лидера — из конфига
// запуска; зеркало узнаёт эпоху лидера при подключении, promote даёт epoch + 1.
const demoEpoch = Number(process.env.DEMO_EPOCH ?? 1)

type DemoIceServer = {
    urls: string | string[]
    username?: string
    credential?: string
}

function isIceServer(value: unknown): value is DemoIceServer {
    if (value == null || typeof value != 'object') return false
    const {urls, username, credential} = value as DemoIceServer
    const validUrls = typeof urls == 'string'
        || (Array.isArray(urls) && urls.length > 0 && urls.every(url => typeof url == 'string'))
    return validUrls
        && (username == null || typeof username == 'string')
        && (credential == null || typeof credential == 'string')
}

function readDemoIceServers() {
    const raw = process.env.DEMO_RTC_ICE_SERVERS
    if (!raw) return [{urls: 'stun:stun.l.google.com:19302'}]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every(isIceServer)) {
        throw new Error('DEMO_RTC_ICE_SERVERS must be a JSON array of RTCIceServer objects')
    }
    return parsed
}

const rtcConfiguration = {iceServers: readDemoIceServers()}

// ============== public-exposure guards (demo policy, not library API) ==============
// The stand is one shared world; these bounds keep a public instance memory-flat
// and usable when strangers find it. Rate limiting is shown on the two surfaces
// with hand-written fragments (workboard, rooms); the injected-port stands are
// bounded by the storage quotas and TTL sweep below.
const guards = {
    uploadLimitBytes: 8 * 1024 * 1024,
    uploadBudgetBytes: 64 * 1024 * 1024,
    uploadTtlMs: Number(process.env.DEMO_UPLOAD_TTL_MS ?? 15 * 60_000),
    workboardMaxItems: 200,
    maxRooms: 40,
    commandsPerMinute: 120,
    offlineAccountTtlMs: 60 * 60_000,
}

const commandUse = new Map<string, {count: number, resetAt: number}>()

function limited<A extends unknown[], R>(account: string, action: (...args: A) => R) {
    return function limitedCommand(...args: A) {
        const now = Date.now()
        const use = commandUse.get(account)
        if (!use || use.resetAt <= now) commandUse.set(account, {count: 1, resetAt: now + 60_000})
        else if (++use.count > guards.commandsPerMinute) throw new Error('demo rate limit — slow down a little')
        return action(...args)
    }
}

function limitCommands<T extends Record<string, any>>(account: string, fragment: T, names: (keyof T)[]) {
    const result: any = {...fragment}
    for (const name of names) result[name] = limited(account, fragment[name] as any)
    return result as T
}

function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function artifactPage(prompt: string) {
    // The prompt becomes data, never executable markup in the generated artifact.
    const title = JSON.stringify('Demo artifact for: ' + prompt).replace(/</g, '\\u003c')
    return `<!doctype html>
<meta charset="utf-8">
<title>Demo artifact</title>
<style>body{font:16px system-ui;margin:24px;color:#223}button{padding:7px 12px}output{font-weight:700}</style>
<h3>AI-created sandbox artifact</h3><p id="title"></p><button id="add">increment</button> <output id="count">0</output>
<script>const title=${title};let count=0;document.querySelector('#title').textContent=title;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=String(++count)</script>`
}

// ============== storage intent + AI job stand ==============
// The resource layer never sees these bytes. A real app swaps this tiny HTTP
// port for S3/MinIO/etc. and returns its own short-lived signed instructions.
const uploadTickets = new Map<string, {size: number, ticket: string, at: number}>()
const uploadBytes = new Map<string, Buffer>()
let nextTicket = 0

function storedUploadBytes() {
    let total = 0
    for (const bytes of uploadBytes.values()) total += bytes.byteLength
    return total
}

function dropUpload(fileId: string) {
    uploadTickets.delete(fileId)
    uploadBytes.delete(fileId)
}

const files = createFileJobHost({
    storage: {
        beginUpload({file}) {
            if (file.size > guards.uploadLimitBytes) throw new Error('demo uploads are capped at 8 MB')
            if (storedUploadBytes() + file.size > guards.uploadBudgetBytes) {
                throw new Error('demo storage budget is full — old uploads expire in a few minutes')
            }
            const ticket = 'demo-upload-' + (++nextTicket)
            uploadTickets.set(file.id, {size: file.size, ticket, at: Date.now()})
            return {url: '/resource-upload/' + file.id + '?ticket=' + ticket, method: 'PUT'}
        },
        confirmUpload({file}) {
            if (!uploadBytes.has(file.id)) throw new Error('the upload endpoint has not received this file')
        },
        download({file}) {
            const ticket = uploadTickets.get(file.id)?.ticket
            if (!ticket) throw new Error('upload ticket expired')
            return {url: '/resource-download/' + file.id + '?ticket=' + ticket}
        },
    },
    runner: {
        async run({file, report, cancelled}) {
            report({progress: 0.2, message: 'AI reading ' + file.name})
            await delay(500)
            if (cancelled()) return
            report({progress: 0.75, message: 'AI preparing a result'})
            await delay(500)
            if (cancelled()) return
            return {result: {summary: `Demo AI processed ${file.name} (${file.size} bytes)`}}
        },
    },
    drain: 'micro',
})

// ============== artifact storage + browser sandbox stand ==============
// The Artifact host never sees these HTML bytes. Its private key map only asks
// this adapter for a short-lived, cross-origin read instruction when authorized.
const artifactBytes = new Map<string, string>()
const artifactTickets = new Map<string, {artifactId: string, storageKey: string, expiresAt: number}>()
let nextArtifactKey = 0
let nextArtifactTicket = 0
const artifacts = createArtifactHost({
    storage: {
        open({artifact, storageKey}) {
            const ticket = 'demo-artifact-ticket-' + (++nextArtifactTicket)
            const expiresAt = Date.now() + 60_000
            artifactTickets.set(ticket, {artifactId: artifact.id, storageKey: String(storageKey), expiresAt})
            // Separate cookie-free origin: the iframe is not the app/RPC origin.
            return {url: 'http://artifact.localhost:' + port + '/artifact-open/' + artifact.id + '?ticket=' + ticket, expiresAt}
        },
        remove({storageKey}) {
            const key = String(storageKey)
            artifactBytes.delete(key)
            for (const [ticket, value] of artifactTickets) if (value.storageKey == key) artifactTickets.delete(ticket)
        },
    },
    // The stand is one shared room (like the conversation): artifacts are visible
    // to every participant; revoke stays owner-only. A mirror instance re-applies
    // this same read policy on its own edge.
    policy: {canRead: () => true},
    drain: 'micro',
})

// ============== multi-channel conversation + structured facts stand ==============
// This runtime is deliberately in-memory. A production app injects the documented
// atomic persistence port and rehydrates both its projection and request receipts.
const conversations = createConversationHost({
    // This stand is one public room: presence, not a pre-seeded account list,
    // determines who is currently in it.
    policy: {canRead: () => true, canWrite: () => true},
    drain: 'micro',
})
const conversationReady = (async function prepareDemoConversation() {
    const created = await conversations.control.createConversation('a', {
        requestId: 'demo-conversation', title: 'Dynamic AI workspace', rootTitle: 'Main', participantIds: ['b'],
    })
    const welcome = await conversations.control.appendMessage('demo-system', {
        requestId: 'demo-welcome', conversationId: created.conversation.id, channelId: created.channel.id,
        author: {kind: 'system', id: 'demo', label: 'Stand'},
        blocks: [
            {kind: 'text', version: 1, text: 'One conversation can contain native text, lists, tables, facts and child dialogues.'},
            {kind: 'list', version: 1, style: 'check', items: [
                {text: 'post from either participant', checked: true},
                {text: 'fork any latest message into a child dialogue'},
                {text: 'override inherited facts in that child'},
            ]},
            {kind: 'custom', version: 1, type: 'demo.metric', data: {value: 1, unit: 'shared RPC connection'}},
        ],
    })
    await conversations.control.upsertFact('demo-system', {
        requestId: 'demo-fact-language', conversationId: created.conversation.id, scope: {kind: 'conversation'},
        namespace: 'workspace', key: 'language', value: 'ru', expectedRevision: 0, sourceMessageId: welcome.id,
    }, {kind: 'system', id: 'demo-bootstrap'})
    return created
})()

// ============== generic AI run stand ==============
// A provider adapter belongs here. This deterministic runner makes the protocol
// observable without placing vendor credentials or model internals in RPC.
const ai = createAiRunHost({
    capabilities: [{kind: 'assistant', label: 'Demo assistant', acceptsResources: true}],
    runner: {
        async run({run, input, resourceIds, report, emit, artifact, cancelled}) {
            const prompt = String((input as any)?.prompt ?? '')
            report({progress: 0.15, message: 'AI is preparing context'})
            emit({type: 'text.delta', text: 'I received: '})
            await delay(350)
            if (cancelled()) return
            emit({type: 'text.delta', text: prompt || '(empty prompt)'})
            report({progress: 0.75, message: 'AI is composing a response', usage: {inputTokens: 8, outputTokens: 12, totalTokens: 20}})
            await delay(350)
            if (cancelled()) return
            const resourceId = resourceIds[0]
            const html = artifactPage(prompt)
            const descriptor = {
                kind: 'demo-counter', label: 'Interactive demo counter', runtime: 'sandboxed-iframe' as const, mime: 'text/html',
                // Контент-адресация: версия артефакта = hash его байтов; при передаче между узлами она сверяется.
                version: await sha256Hex(html),
            }
            const retention = {class: 'ephemeral' as const, expiresAt: Date.now() + 10 * 60_000}
            let registered: ArtifactRecord
            if (upstreamLink) {
                // Зеркальный инстанс не хранит байты сам: регистрация форвардится источнику истины,
                // а каталог вернётся сюда обычной репликацией.
                registered = await upstreamLink.artifacts.register(run.owner, {descriptor, retention, html})
            } else {
                const storageKey = 'demo-artifact-' + (++nextArtifactKey)
                artifactBytes.set(storageKey, html)
                registered = artifacts.register({owner: run.owner, descriptor, storageKey, retention})
            }
            artifact({
                kind: 'demo-artifact',
                label: registered.descriptor.label,
                descriptor: {artifactId: registered.id, resourceId},
            })
            return {
                result: {answer: 'Demo answer for: ' + prompt, resourceId},
                usage: {inputTokens: 8, outputTokens: 12, totalTokens: 20},
            }
        },
    },
    drain: 'micro',
})

// ============== authoritative Store example ==============
const workboard = createWorkboardHost({
    maxItems: guards.workboardMaxItems,
    initial: [
        {id: 'welcome', title: 'Open this stand in another tab', status: 'done'},
        {id: 'rooms', title: 'Join a video room with both participants', status: 'active'},
        {id: 'store', title: 'Change this board and watch every tab update', status: 'new'},
    ],
})

// ============== video rooms: application policy over the media relay ==============
type VideoRoomEntry = {id: string, name: string, members: Set<string>}

function createVideoRooms() {
    const rooms = new Map<string, VideoRoomEntry>()
    const accountRooms = new Map<string, string>()
    const emptyTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const [emitChange, changes] = listen<[number]>()
    // Empty rooms linger briefly so a reload or reconnect does not kill them.
    const emptyRoomGraceMs = Number(process.env.DEMO_ROOM_TTL_MS ?? 30_000)
    let revision = 0
    let nextRoom = 1

    rooms.set('room-1', {id: 'room-1', name: 'Demo room', members: new Set()})

    function scheduleRemoval(roomId: string) {
        const timer = setTimeout(function removeEmptyRoom() {
            emptyTimers.delete(roomId)
            const room = rooms.get(roomId)
            if (!room || room.members.size > 0) return
            rooms.delete(roomId)
            changed()
        }, emptyRoomGraceMs)
        ;(timer as any).unref?.()
        emptyTimers.set(roomId, timer)
    }

    function cancelRemoval(roomId: string) {
        const timer = emptyTimers.get(roomId)
        if (timer == null) return
        clearTimeout(timer)
        emptyTimers.delete(roomId)
    }

    function roomInfo(room: VideoRoomEntry) {
        return {id: room.id, name: room.name, members: Array.from(room.members).sort()}
    }

    function changed() {
        emitChange(++revision)
    }

    function detach(account: string) {
        const roomId = accountRooms.get(account)
        if (!roomId) return false
        accountRooms.delete(account)
        const room = rooms.get(roomId)
        if (room) {
            room.members.delete(account)
            // Covers explicit leave, switching rooms and presence-offline cleanup.
            if (room.members.size == 0) scheduleRemoval(roomId)
        }
        return true
    }

    function leave(account: string) {
        const left = detach(account)
        if (left) changed()
        return left
    }

    function join(account: string, roomId: string) {
        const room = rooms.get(roomId)
        if (!room) throw new Error('video room does not exist')
        if (accountRooms.get(account) == roomId) return snapshot(account)
        detach(account)
        cancelRemoval(roomId)
        accountRooms.set(account, roomId)
        room.members.add(account)
        changed()
        return snapshot(account)
    }

    function create(account: string, requestedName: unknown) {
        const name = String(requestedName ?? '').trim().slice(0, 48)
        if (!name) throw new Error('video room name is required')
        if (rooms.size >= guards.maxRooms) throw new Error('demo room limit reached — join an existing room')
        const id = 'room-' + (++nextRoom)
        rooms.set(id, {id, name, members: new Set()})
        return join(account, id)
    }

    function snapshot(account: string) {
        return {
            revision,
            currentRoomId: accountRooms.get(account) ?? null,
            rooms: Array.from(rooms.values()).map(roomInfo),
        }
    }

    function connection(account: string) {
        return {
            snapshot: () => snapshot(account),
            create: (name: unknown) => create(account, name),
            join: (roomId: string) => join(account, roomId),
            leave: () => {
                leave(account)
                return snapshot(account)
            },
            changes,
        }
    }

    return {
        connection,
        leave,
        canWatch(watcher: string, owner: string) {
            const roomId = accountRooms.get(watcher)
            return watcher != owner && !!roomId && accountRooms.get(owner) == roomId
        },
    }
}

// ============== media relay + room/call-driven watch ACL ==============
// The signal hub is the single policy boundary, but authorization still needs a tiny
// server-owned call lifecycle: an arbitrary forged `accept` must never grant media.
function createCallWatchPolicy() {
    type Call = {caller: string, callee: string, state: 'ringing' | 'active', timer: any}
    const calls = new Map<string, Call>()
    const grants = new Set<string>()

    function grant(a: string, b: string, on: boolean) {
        if (on) { grants.add(a + '|' + b); grants.add(b + '|' + a) }
        else { grants.delete(a + '|' + b); grants.delete(b + '|' + a) }
    }

    function finish(pair: string, reason: string) {
        const call = calls.get(pair)
        if (!call) return
        calls.delete(pair)
        clearTimeout(call.timer)
        grant(call.caller, call.callee, false)
        console.log(`[demo] call down: ${call.caller} <-> ${call.callee} (${reason})`)
    }

    function authorize(env: SignalEnvelope) {
        if (env.type == 'ring') {
            if (!env.pair.startsWith('call:') || env.from == env.to || calls.has(env.pair)) return false
            const timer = setTimeout(function expireServerCall() { finish(env.pair, 'expired') }, 35_000)
            timer.unref?.()
            calls.set(env.pair, {caller: env.from, callee: env.to, state: 'ringing', timer})
            return true
        }
        if (env.type != 'accept' && env.type != 'decline' && env.type != 'hangup') return true
        const call = calls.get(env.pair)
        if (!call) return false
        const reverse = env.from == call.callee && env.to == call.caller
        const participant = (env.from == call.caller && env.to == call.callee) || reverse
        if (env.type == 'accept') {
            if (call.state != 'ringing' || !reverse) return false
            call.state = 'active'
            clearTimeout(call.timer)
            call.timer = null
            grant(call.caller, call.callee, true)
            console.log(`[demo] call up: ${call.caller} <-> ${call.callee} (media granted)`)
            return true
        }
        if (env.type == 'decline' && (!reverse || call.state != 'ringing')) return false
        if (!participant) return false
        finish(env.pair, env.type)
        return true
    }

    function dropAccount(account: string) {
        for (const [pair, call] of calls) {
            if (call.caller == account || call.callee == account) finish(pair, 'offline')
        }
        for (const key of Array.from(grants)) {
            if (key.startsWith(account + '|') || key.endsWith('|' + account)) grants.delete(key)
        }
    }

    return {
        authorize,
        canWatch: (watcher: string, owner: string) => grants.has(watcher + '|' + owner),
        dropAccount,
    }
}

const videoRooms = createVideoRooms()
const callPolicy = createCallWatchPolicy()
const media = createMediaRelay({
    lines: {cam: 'video', mic: 'audio', screen: 'video'},
    canWatch: (watcher, owner) => videoRooms.canWatch(watcher, owner) || callPolicy.canWatch(watcher, owner),
})
const host = createPeerHost({authorize: callPolicy.authorize})

// Presence cleanup retires media lines and every call/grant involving the account.
const offlineSince = new Map<string, number>()
host.presence.changes.on(function onPresenceEdge(ch) {
    console.log(`[demo] presence: ${ch.account} ${ch.online ? 'online' : 'offline'}`)
    if (ch.online) {
        offlineSince.delete(ch.account)
        return
    }
    offlineSince.set(ch.account, Date.now())
    videoRooms.leave(ch.account)
    callPolicy.dropAccount(ch.account)
    media.dropAccount(ch.account)
})

// One janitor keeps a long-running public stand memory-flat: expired upload
// bytes, expired artifact open-tickets, and accounts that never came back.
const janitor = setInterval(function sweepDemoGarbage() {
    const now = Date.now()
    for (const [fileId, ticket] of uploadTickets) {
        if (now - ticket.at > guards.uploadTtlMs) dropUpload(fileId)
    }
    for (const [ticket, value] of artifactTickets) {
        if (value.expiresAt <= now) artifactTickets.delete(ticket)
    }
    for (const [account, since] of offlineSince) {
        if (now - since <= guards.offlineAccountTtlMs) continue
        offlineSince.delete(account)
        commandUse.delete(account)
        for (const [tab, mapped] of participantAccounts) {
            if (mapped == account) participantAccounts.delete(tab)
        }
    }
}, 60_000)
janitor.unref?.()

const app = express()
app.put('/resource-upload/:fileId', express.raw({type: '*/*', limit: '9mb'}), function receiveResourceUpload(req, res) {
    const expected = uploadTickets.get(req.params.fileId)
    const body = req.body
    if (!expected || req.query.ticket != expected.ticket || !Buffer.isBuffer(body) || body.byteLength != expected.size) {
        res.status(400).send('invalid upload instruction')
        return
    }
    uploadBytes.set(req.params.fileId, body)
    res.status(204).end()
})
app.get('/resource-download/:fileId', function downloadResource(req, res) {
    const expected = uploadTickets.get(req.params.fileId)
    const bytes = uploadBytes.get(req.params.fileId)
    if (!expected || req.query.ticket != expected.ticket || !bytes) {
        res.status(404).end()
        return
    }
    res.type('application/octet-stream').send(bytes)
})
app.get('/artifact-open/:artifactId', function openArtifact(req, res) {
    const ticket = typeof req.query.ticket == 'string' ? artifactTickets.get(req.query.ticket) : undefined
    if (req.hostname != 'artifact.localhost' || !ticket || ticket.artifactId != req.params.artifactId || ticket.expiresAt <= Date.now()) {
        res.status(404).end()
        return
    }
    const html = artifactBytes.get(ticket.storageKey)
    if (!html) {
        res.status(404).end()
        return
    }
    res.set({
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:" + port,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
    })
    res.type('html').send(html)
})
app.use(express.static(path.resolve(__dirname, 'public'), {
    // The stand is rebuilt in place; stale browser bundles otherwise keep an
    // old RPC client alive while the page itself still looks healthy.
    etag: false,
    lastModified: false,
    cacheControl: false,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store')
    },
}))
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')))

const httpServer = createServer(app)
// screen-share JPEG frames can exceed the 1MB Socket.IO default
const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})
const participantAccounts = new Map<string, string>()
let nextParticipant = 0

function participantAccount(tab: string) {
    const existing = participantAccounts.get(tab)
    if (existing) return existing
    let n = nextParticipant++
    let label = ''
    do {
        label = String.fromCharCode(65 + n % 26) + label
        n = Math.floor(n / 26) - 1
    } while (n >= 0)
    const account = 'person-' + accountPrefix + label.toLowerCase()
    participantAccounts.set(tab, account)
    return account
}

// ============== mirror mode: the workboard follows the leader stand ==============
type tWorkboardCommand = 'create' | 'rename' | 'move' | 'assign' | 'remove'
const workboardCommands: tWorkboardCommand[] = ['create', 'rename', 'move', 'assign', 'remove']

function mirrorAccount(who: unknown) {
    const value = String(who ?? '').trim()
    if (!value || value.length > 64) throw new Error('mirror account is invalid')
    return value
}

// Trusted entry for a connected mirror: same commands, but with the END client's
// account — idempotency receipts key on (account, requestId) across the hop.
// Rate limiting stays per end account, so mirror clients share the same budget.
function mirrorFragment() {
    function mirrorCommand(name: tWorkboardCommand) {
        return function forwardedCommand(who: unknown, input: unknown) {
            const account = mirrorAccount(who)
            return limited(account, function applyForwarded(value: any) {
                // после promote авторитет доски — повышенный хост, не изначальный
                const authority = upstreamLink?.promotedWorkboard() ?? workboard
                return (authority.control as any)[name](account, value)
            })(input)
        }
    }
    const commands: Record<string, (who: unknown, input: unknown) => unknown> = {}
    for (const name of workboardCommands) commands[name] = mirrorCommand(name)
    return {workboard: commands}
}

// Trusted artifact entries for a connected mirror: bytes by id (behind the host's
// own authorization/ticket path), forwarded register with a receiving-side hash
// check, and revoke executed with the END client's authority.
function mirrorArtifactsFragment(link: {open: (artifactId: string) => Promise<{url: string}> | {url: string}}) {
    return {
        async bytes(artifactId: unknown) {
            const instruction = await link.open(String(artifactId))
            const ticket = new URL(instruction.url).searchParams.get('ticket')
            const stored = ticket ? artifactTickets.get(ticket) : undefined
            const html = stored ? artifactBytes.get(stored.storageKey) : undefined
            if (html == null) throw new Error('artifact transfer: bytes are unavailable')
            return html
        },
        register(who: unknown, input: unknown) {
            const account = mirrorAccount(who)
            return limited(account, async function registerForwarded(value: any) {
                const html = String(value?.html ?? '')
                if (!html || html.length > 2 * 1024 * 1024) throw new Error('artifact register: html size is out of bounds')
                const base = value?.descriptor ?? {}
                const descriptor = {
                    kind: String(base.kind ?? ''),
                    label: String(base.label ?? ''),
                    runtime: base.runtime,
                    mime: base.mime == null ? undefined : String(base.mime),
                    version: String(base.version ?? ''),
                }
                // Приёмная сверка контент-хэша: зеркалу не верим на слово.
                if (descriptor.version != await sha256Hex(html)) throw new Error('artifact register: content hash mismatch')
                const retention = (value as any)?.retention?.class == 'persistent'
                    ? {class: 'persistent' as const}
                    : {class: 'ephemeral' as const, expiresAt: Date.now() + 10 * 60_000}
                const storageKey = 'demo-artifact-' + (++nextArtifactKey)
                artifactBytes.set(storageKey, html)
                return artifacts.register({owner: account, descriptor, storageKey, retention})
            })(input)
        },
        async revoke(who: unknown, artifactId: unknown) {
            const connection = artifacts.connection(mirrorAccount(who))
            try { return await connection.fragment.revoke(String(artifactId)) }
            finally { connection.close() }
        },
    }
}

type UpstreamLink = Awaited<ReturnType<typeof connectUpstream>>
let upstreamLink: UpstreamLink | null = null

async function connectUpstream(target: string) {
    console.log(`[demo] mirror mode: connecting to the leader at ${target}`)
    const hub = createRpcClientHub(
        () => ioClient(target, {
            transports: ['websocket'],
            auth: {tab: 'mirror-' + process.pid, role: 'mirror', token: process.env.DEMO_MIRROR_TOKEN ?? ''},
        }),
        r => ({app: r<any>('app')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.app.readyStrict()
    const leader = clients.app.func as any
    // Эпоха лидера — точка отсчёта fork-choice: наш promote выдаст leaderEpoch + 1
    const leaderEpoch = Number(await leader.epoch().catch(() => 1) ?? 1)
    const follower = createStoreFollower<WorkboardState>({remote: leader.workboard.state, epoch: leaderEpoch})
    follower.status.on(function logLeaderLinkEdge() {
        const {upstream, seq, epoch} = follower.status.state
        console.log(`[demo] leader link: ${upstream} (seq ${seq}, epoch ${epoch})`)
    })

    // ============== failover: ручное повышение этого узла до лидера ==============
    // Каскадный журнал продолжает жить над ТЕМ ЖЕ store — подписки клиентов этого
    // узла переживают смену роли без разрыва; авторитет команд (ревизии, квитанции,
    // лимит доски) строится workboard-хостом НАД зеркальным store как есть.
    let promotedHost: WorkboardHost | null = null
    function promoteToLeader() {
        if (promotedHost) return {epoch: follower.status.state.epoch, already: true}
        const handover = follower.promote()
        promotedHost = createWorkboardHost({store: handover.store, maxItems: guards.workboardMaxItems})
        console.log(`[demo] PROMOTED: this node is now the workboard leader (epoch ${handover.epoch})`)
        return {epoch: handover.epoch, already: false}
    }

    function forwardCommand(name: tWorkboardCommand, account: string) {
        return function forwardToLeader(input: unknown) {
            // после promote команды применяются локально — этот узел и есть лидер
            if (promotedHost) return (promotedHost.control as any)[name](account, input)
            if (!(hub.socket as any)?.connected) throw new Error('leader offline — try again soon')
            return leader.mirror.workboard[name](account, input)
        }
    }
    function fragmentFor(account: string) {
        const fragment: any = {state: follower.api.replay}
        for (const name of workboardCommands) fragment[name] = forwardCommand(name, account)
        return fragment
    }

    // ============== артефакты: каталог-фолловер + ленивые байты по hash ==============
    const artifactCatalog = createStoreFollower<ArtifactStore>({remote: leader.artifacts.state, initial: {artifacts: {}}})
    const artifactCache = createArtifactByteCache({
        fetch: function fetchArtifactBytes(artifact: ArtifactRecord) { return leader.mirror.artifacts.bytes(artifact.id) },
        onEvict: function dropEvictedBytes(hash: string) { artifactBytes.delete('hash:' + hash) },
    })
    const artifactMirror = createArtifactMirror({
        catalog: artifactCatalog.store,
        policy: {canRead: () => true},
        async open({artifact}) {
            // промах → байты у лидера (RPC) → sha256-сверка в кэше → раздача СВОИМ тикетом
            const {hash, bytes} = await artifactCache.get(artifact)
            const key = 'hash:' + hash
            if (!artifactBytes.has(key)) artifactBytes.set(key, String(bytes))
            const ticket = 'demo-artifact-ticket-' + (++nextArtifactTicket)
            const expiresAt = Date.now() + 60_000
            artifactTickets.set(ticket, {artifactId: artifact.id, storageKey: key, expiresAt})
            return {url: 'http://artifact.localhost:' + port + '/artifact-open/' + artifact.id + '?ticket=' + ticket, expiresAt}
        },
        revoke: function forwardRevoke(account: string, artifactId: string) { return leader.mirror.artifacts.revoke(account, artifactId) },
        drain: 'micro',
    })
    const artifactsLink = {
        mirror: artifactMirror,
        register: (who: string, input: {descriptor: unknown, retention: unknown, html: string}) => leader.mirror.artifacts.register(who, input),
    }

    await Promise.all([follower.ready, artifactCatalog.ready])
    console.log('[demo] leader board and artifact catalog mirrored, cascade is live')
    return {
        hub,
        follower,
        fragmentFor,
        artifacts: artifactsLink,
        promote: promoteToLeader,
        isPromoted: () => promotedHost != null,
        promotedWorkboard: () => promotedHost,
    }
}

// Which node this connection landed on — the client shows it as a badge.
// В зеркальном режиме сюда же входит ручной failover: promote() повышает этот
// узел до лидера (доска продолжает жить локально, epoch растёт на 1).
function instanceFragment() {
    if (!upstreamLink) return {role: () => 'leader', epoch: () => demoEpoch, upstream: () => null}
    const link = upstreamLink
    const status = link.follower.status
    return {
        role: () => link.isPromoted() ? 'leader·promoted' : 'mirror',
        epoch: () => status.state.epoch,
        upstream: () => status.snapshot(),
        changed: status.listen(),
        promote: () => link.promote(),
    }
}

ioServer.on('connection', function onDemoConnection(socket) {
    const tab = socket.handshake.auth?.tab
    if (typeof tab != 'string' || !tab) {
        socket.disconnect(true)
        return
    }
    // A follower instance connects with role=mirror: no presence, no participant
    // account — only the replay line and the trusted forwarded-command entry.
    if (socket.handshake.auth?.role == 'mirror') {
        const expectedToken = process.env.DEMO_MIRROR_TOKEN ?? ''
        // Зеркала обслуживает ЛИДЕР — изначальный или повышенный: после failover
        // этот узел принимает вернувшиеся узлы уже как их новый лидер (epoch выше).
        const canServeMirrors = !mirrorOf || Boolean(upstreamLink?.isPromoted())
        if (!canServeMirrors || (expectedToken && socket.handshake.auth?.token != expectedToken)) {
            socket.disconnect(true)
            return
        }
        const [mirrorGone, mirrorGoneListen] = listen<[]>()
        const mirrorArtifacts = artifacts.connection('mirror-link')
        socket.on('disconnect', function closeMirrorLink() {
            mirrorGone()
            mirrorArtifacts.close()
            console.log('[demo] mirror link closed')
        })
        createRpcServerAuto({
            socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
            socketKey: 'app',
            object: {
                // Повышенный узел раздаёт СВОЮ эпоху и СВОЙ каскад (та же линия, что у его клиентов)
                epoch: () => upstreamLink ? upstreamLink.follower.status.state.epoch : demoEpoch,
                workboard: {state: upstreamLink ? upstreamLink.follower.api.replay : workboard.connection('mirror-link').fragment.state},
                artifacts: mirrorArtifacts.fragment,
                mirror: {...mirrorFragment(), artifacts: mirrorArtifactsFragment(mirrorArtifacts.fragment)},
            },
            disconnectListen: mirrorGoneListen,
        })
        console.log('[demo] mirror link connected')
        return
    }
    const account = participantAccount(tab)
    const peer = host.connection(account)
    const resource = files.connection(account)
    const aiRun = ai.connection(account)
    // На зеркале каталог артефактов — реплика: та же форма фрагмента, read-edge
    const artifact = upstreamLink ? upstreamLink.artifacts.mirror.connection(account) : artifacts.connection(account)
    const conversation = conversations.connection(account)
    const workboardConnection = upstreamLink ? null : workboard.connection(account)
    const workboardFragment = upstreamLink ? upstreamLink.fragmentFor(account) : workboardConnection!.fragment
    const [disconnect, disconnectListen] = listen<[]>()
    socket.on('disconnect', function closeDemoResources() {
        disconnect()
        peer.close()
        resource.close()
        aiRun.close()
        artifact.close()
        conversation.close()
        workboardConnection?.close()
    })
    createRpcServerAuto({
        socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
        socketKey: 'app',
        object: {
            // legacy key on the SAME connection — the SDK does not displace old code
            serverTime: () => new Date().toISOString(),
            // Deployment owns ICE/TURN credentials; the SDK only receives an rtc factory.
            demo: {
                account: () => account,
                rtcConfiguration: () => rtcConfiguration,
                instance: instanceFragment(),
                rooms: limitCommands(account, videoRooms.connection(account), ['create', 'join', 'leave']),
            },
            peer: peer.fragment,
            files: resource.fragment,
            ai: aiRun.fragment,
            artifacts: artifact.fragment,
            conversation: conversation.fragment,
            workboard: limitCommands(account, workboardFragment, ['create', 'rename', 'move', 'assign', 'remove']),
            media: {
                publish: media.publishOf(account),
                // policy-gated view: THIS connection's account is what canWatch receives
                watch: media.watchOf(account),
            },
        },
        disconnectListen,
    })
    console.log(`[demo] ${account} connected`)
})

function listenOn(port: number) {
    return new Promise<boolean>(function waitForListen(resolve, reject) {
        function onError(error: NodeJS.ErrnoException) {
            httpServer.off('listening', onListen)
            if (error.code == 'EADDRINUSE') {
                resolve(false)
                return
            }
            reject(error)
        }

        function onListen() {
            httpServer.off('error', onError)
            resolve(true)
        }

        httpServer.once('error', onError)
        httpServer.once('listening', onListen)
        httpServer.listen(port, listenHost)
    })
}

async function listenOnAvailablePort() {
    for (let candidate = portStart; candidate <= portEnd; candidate++) {
        if (await listenOn(candidate)) return candidate
    }
    throw new Error(`no free demo port in ${portStart}-${portEnd}`)
}

async function startDemo() {
    await conversationReady
    if (mirrorOf) upstreamLink = await connectUpstream(mirrorOf)
    port = await listenOnAvailablePort()
    console.log('[demo] shared-cursor + calls + Conversation stand is up:')
    console.log(`  open each participant tab: http://localhost:${port}/`)
    console.log(`  artifact origin: http://artifact.localhost:${port} (sandboxed iframe only)`)
    if (mirrorOf) console.log(`  this instance mirrors the workboard of ${mirrorOf}`)
}

void startDemo()

// ============== graceful shutdown ==============
function shutdown(signal: string) {
    console.log(`[demo] ${signal} — closing`)
    ioServer.close()
    httpServer.close(function exitWhenClosed() { process.exit(0) })
    const force = setTimeout(function exitForced() { process.exit(0) }, 2000)
    ;(force as any).unref?.()
}
process.on('SIGINT', function onSigint() { shutdown('SIGINT') })
process.on('SIGTERM', function onSigterm() { shutdown('SIGTERM') })
