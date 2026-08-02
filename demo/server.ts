// Demo stand server: the Peer SDK, application RPC facade and static page hosting.
// Run: npm run demo  ->  open the two printed URLs in two tabs.
import express, {type NextFunction, type Request, type Response} from 'express'
import {randomUUID} from 'crypto'
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
import {createHttpFacadeServer} from '../src/server/httpFacadeServer'
import {createDevModuleBridge} from './dev-module-bridge'
import {io as ioClient} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createStoreFollower} from '../src/Common/Observe/store-follower'
import {createArtifactByteCache, createArtifactMirror, sha256Hex} from '../src/Common/artifact/artifact-index'
import type {ArtifactRecord, ArtifactStore} from '../src/Common/artifact/artifact-index'
import {createWorkboardHost, WorkboardHost} from './workboard-host'
import type {WorkboardState} from './workboard-contract'
import {createAuthLifecycleHost} from './auth-lifecycle-host'
import {authSocketKeys} from './auth-lifecycle-contract'
import {demoRpcOpt} from './protocol-schema'

const portStart = Number(process.env.DEMO_PORT_START ?? 3100)
const portEnd = Number(process.env.DEMO_PORT_END ?? 3500)
const listenHost = process.env.DEMO_HOST
let port = portStart

// ============== instance role: standalone leader or a mirror of another stand ==============
// DEMO_MIRROR_OF=http://localhost:3100 turns this instance into a follower: the
// workboard store is mirrored from the leader over the ordinary replay wire and
// commands are forwarded with the end client's account — receipts and ordering
// stay on the leader as the single point of order.
const mirrorOf = process.env.DEMO_MIRROR_OF?.trim() || null
// Mirror participants get their own letter namespace (person-za, person-zb, ...)
// so the shared board never shows two different people as the same "Participant A".
const accountPrefix = (process.env.DEMO_ACCOUNT_PREFIX ?? (mirrorOf ? 'z' : '')).trim().toLowerCase()
// Epoch line (fork-choice during failover): standalone leader takes it from config
// startup; mirror learns leader epoch on connect, promote yields epoch + 1.
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
const configuredHttpFacadeToken = process.env.DEMO_HTTP_FACADE_TOKEN?.trim() || null
const httpFacadeToken = configuredHttpFacadeToken ?? randomUUID()

function configuredOrigin(value: string, label: string) {
    let url
    try { url = new URL(value) }
    catch { throw new Error(label + ' must be an absolute http(s) origin') }
    if ((url.protocol != 'http:' && url.protocol != 'https:') || url.username || url.password
        || url.pathname != '/' || url.search || url.hash) {
        throw new Error(label + ' must contain only an http(s) origin')
    }
    return url.origin
}

function readConfiguredAppOrigins() {
    const raw = process.env.DEMO_APP_ORIGINS
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length == 0 || parsed.some(value => typeof value != 'string')) {
        throw new Error('DEMO_APP_ORIGINS must be a non-empty JSON string array')
    }
    return parsed.map(value => configuredOrigin(value, 'DEMO_APP_ORIGINS entry'))
}

const configuredArtifactOrigin = process.env.DEMO_ARTIFACT_ORIGIN
    ? configuredOrigin(process.env.DEMO_ARTIFACT_ORIGIN, 'DEMO_ARTIFACT_ORIGIN')
    : null
const configuredAppOrigins = readConfiguredAppOrigins()

function artifactOrigin() {
    return configuredArtifactOrigin ?? 'http://artifact.localhost:' + port
}

function artifactFrameAncestors() {
    return configuredAppOrigins ?? ['http://localhost:' + port]
}

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
            return {url: artifactOrigin() + '/artifact-open/' + artifact.id + '?ticket=' + ticket, expiresAt}
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
                // Content addressing: artifact version = hash of its bytes; verified when transferred between nodes.
                version: await sha256Hex(html),
            }
            const retention = {class: 'ephemeral' as const, expiresAt: Date.now() + 10 * 60_000}
            let registered: ArtifactRecord
            if (upstreamLink) {
                // Mirror instance doesn't store bytes itself: registration is forwarded to source of truth,
                // and the catalog is returned here via normal replication.
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

// ============== auth lifecycle: a real short-lived token on its own connection ==============
// The participant connection above is deliberately ungated; this stand runs its own
// socket so `gate: true`, an anonymous starting facade and a real expiry/revocation
// cycle can be watched without changing anything the other stands rely on.
const authLifecycle = createAuthLifecycleHost()

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
        close() {
            for (const timer of emptyTimers.values()) clearTimeout(timer)
            emptyTimers.clear()
            accountRooms.clear()
            rooms.clear()
            changes.close()
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
        close() {
            for (const pair of Array.from(calls.keys())) finish(pair, 'stand closed')
            grants.clear()
        },
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

const participantAccounts = new Map<string, string>()
let nextParticipant = 0

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
// The auth stand's identity port. It cannot live on the gated RPC surface: with
// gate: true nothing is callable before a HELLO succeeds, so a login method there
// could never run. Passwords/OAuth/user stores belong here too — the token codec
// says so in its own header, and this endpoint is the smallest honest stand-in.
app.post('/auth-lifecycle/login', express.json({limit: '1kb'}), function issueAuthLifecycleToken(req, res) {
    const result = authLifecycle.control.login((req.body as {sid?: unknown} | undefined)?.sid)
    if (!result.ok) {
        res.status(result.status).json({error: result.error})
        return
    }
    res.json({sid: result.sid, token: result.token, expiresAt: result.expiresAt})
})
app.get('/artifact-open/:artifactId', function openArtifact(req, res) {
    const ticket = typeof req.query.ticket == 'string' ? artifactTickets.get(req.query.ticket) : undefined
    if (req.hostname != new URL(artifactOrigin()).hostname || !ticket
        || ticket.artifactId != req.params.artifactId || ticket.expiresAt <= Date.now()) {
        res.status(404).end()
        return
    }
    const html = artifactBytes.get(ticket.storageKey)
    if (!html) {
        res.status(404).end()
        return
    }
    res.set({
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + artifactFrameAncestors().join(' '),
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
    })
    res.type('html').send(html)
})

// ============== generated HTTP facade example ==============
// This is deliberately one small diagnostics object, not the per-account RPC
// facade. The same object is walked twice to demonstrate GET and POST mirrors.
function authorizeDemoHttpFacade(req: Request, res: Response, next: NextFunction) {
    if (req.get('authorization') == `Bearer ${httpFacadeToken}`) {
        next()
        return
    }
    res.status(401).json({ok: false, error: {message: 'Unauthorized'}})
}

const httpFacadeDemo = {
    demo: {
        status: function httpFacadeStatus() {
            const instance = instanceFragment()
            return {
                time: new Date(),
                role: instance.role(),
                epoch: instance.epoch(),
                participants: participantAccounts.size,
                auth: 'bearer',
            }
        },
        echo: function httpFacadeEcho(value: unknown) {
            return {value, echoedAt: new Date()}
        },
    },
}

const httpFacadeLimits = {
    maxDepth: 8,
    maxKeys: 100,
    maxArgs: 4,
    maxArrayLen: 100,
    maxStringLen: 4096,
}
createHttpFacadeServer({
    app,
    object: httpFacadeDemo,
    method: 'get',
    basePath: '/http-facade',
    middleware: authorizeDemoHttpFacade,
    limits: httpFacadeLimits,
})
createHttpFacadeServer({
    app,
    object: httpFacadeDemo,
    method: 'post',
    basePath: '/http-facade',
    // Reject unauthorized calls before spending work parsing their bodies.
    middleware: [authorizeDemoHttpFacade, express.json({limit: '16kb'})],
    limits: httpFacadeLimits,
})

// ============== optional development module bridge ==============
// Opt in with DEMO_DEV_MODULE=1 (or a path to your own file). The watched file
// becomes a live replaceable module and its own methods become routes, so a
// save is immediately callable. Off by default: it starts a worker thread and
// exposes whatever methods the module happens to have.
const devModulePath = process.env.DEMO_DEV_MODULE?.trim() || null
const devModuleBridge = devModulePath == null ? null : createDevModuleBridge({
    app,
    file: devModulePath == '1'
        ? path.resolve(__dirname, 'dev-module.js')
        : path.resolve(devModulePath),
    basePath: '/dev-module',
    middleware: authorizeDemoHttpFacade,
    slotId: 'demo.dev',
    moduleId: 'demo.dev.impl',
    contractId: 'demo.dev.port',
    capability: 'demo-dev',
    onEvent(event) {
        if (event.type == 'built') console.log(`[demo] dev module build ${event.build} active as ${event.version}`)
        else console.error(`[demo] dev module build ${event.build} rejected: ${event.error}`)
    },
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
                // after promote, board authority is the promoted host, not the original
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
                // Receiving-end content-hash check: we don't trust the mirror's word.
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
        {opt: demoRpcOpt},
    )
    const clients = await hub.setToken(null)
    await clients.app.readyStrict()
    const leader = clients.app.func as any
    // Leader epoch is the fork-choice reference point: our promote will yield leaderEpoch + 1
    const leaderEpoch = Number(await leader.epoch().catch(() => 1) ?? 1)
    const follower = createStoreFollower<WorkboardState>({remote: leader.workboard.state, epoch: leaderEpoch})
    follower.status.on(function logLeaderLinkEdge() {
        const {upstream, seq, epoch} = follower.status.state
        console.log(`[demo] leader link: ${upstream} (seq ${seq}, epoch ${epoch})`)
    })

    // ============== failover: manual promotion of this node to leader ==============
    // Cascading log continues to live over the SAME store — subscriptions of clients on this
    // node survive role change unbroken; authority of commands (revisions, receipts,
    // board limit) is built by workboard-host OVER the mirror store as-is.
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
            // after promote commands are applied locally — this node is the leader
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

    // ============== artifacts: catalog-follower + lazy bytes by hash ==============
    const artifactCatalog = createStoreFollower<ArtifactStore>({remote: leader.artifacts.state, initial: {artifacts: {}}})
    const artifactCache = createArtifactByteCache({
        fetch: function fetchArtifactBytes(artifact: ArtifactRecord) { return leader.mirror.artifacts.bytes(artifact.id) },
        onEvict: function dropEvictedBytes(hash: string) { artifactBytes.delete('hash:' + hash) },
    })
    const artifactMirror = createArtifactMirror({
        catalog: artifactCatalog.store,
        policy: {canRead: () => true},
        async open({artifact}) {
            // miss → bytes from leader (RPC) → sha256-check in cache → delivery by own ticket
            const {hash, bytes} = await artifactCache.get(artifact)
            const key = 'hash:' + hash
            if (!artifactBytes.has(key)) artifactBytes.set(key, String(bytes))
            const ticket = 'demo-artifact-ticket-' + (++nextArtifactTicket)
            const expiresAt = Date.now() + 60_000
            artifactTickets.set(ticket, {artifactId: artifact.id, storageKey: key, expiresAt})
            return {url: artifactOrigin() + '/artifact-open/' + artifact.id + '?ticket=' + ticket, expiresAt}
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
    let closed = false
    return {
        hub,
        follower,
        fragmentFor,
        artifacts: artifactsLink,
        promote: promoteToLeader,
        isPromoted: () => promotedHost != null,
        promotedWorkboard: () => promotedHost,
        close() {
            if (closed) return
            closed = true
            promotedHost?.close()
            artifactMirror.close()
            artifactCatalog.close()
            follower.close()
            artifactCache.clear()
            ;(hub.socket as any)?.disconnect?.()
        },
    }
}

// Which node this connection landed on — the client shows it as a badge.
// In mirror mode, manual failover also enters here: promote() raises this
// node to leader (board continues to live locally, epoch grows by 1).
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
        // Mirrors are served by the LEADER — original or promoted: after failover
        // this node accepts returning nodes as their new leader (higher epoch).
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
                // Promoted node distributes its own epoch and its own cascade (same line as its clients)
                epoch: () => upstreamLink ? upstreamLink.follower.status.state.epoch : demoEpoch,
                workboard: {state: upstreamLink ? upstreamLink.follower.api.replay : workboard.connection('mirror-link').fragment.state},
                artifacts: mirrorArtifacts.fragment,
                mirror: {...mirrorFragment(), artifacts: mirrorArtifactsFragment(mirrorArtifacts.fragment)},
            },
            disconnectListen: mirrorGoneListen,
            opt: demoRpcOpt,
        })
        console.log('[demo] mirror link connected')
        return
    }
    // The auth-lifecycle stand connects with role=auth: no presence, no participant
    // account — only its two GATED facades, each starting from the anonymous object.
    if (socket.handshake.auth?.role == 'auth') {
        const link = authLifecycle.connection()
        const [authLinkGone, authLinkGoneListen] = listen<[]>()
        socket.on('disconnect', function closeAuthLifecycleLink() {
            authLinkGone()
            link.close()
        })
        createRpcServerAuto({socket, socketKey: authSocketKeys.session, ...link.session, disconnectListen: authLinkGoneListen})
        createRpcServerAuto({socket, socketKey: authSocketKeys.vault, ...link.vault, disconnectListen: authLinkGoneListen})
        console.log('[demo] auth lifecycle stand connected')
        return
    }
    const account = participantAccount(tab)
    const peer = host.connection(account)
    const resource = files.connection(account)
    const aiRun = ai.connection(account)
    // On mirror, artifact catalog is a replica: same fragment form, read-edge
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
        socket,
        socketKey: 'app',
        object: {
            // Stable application method beside the SDK fragments on the same connection.
            serverTime: () => new Date().toISOString(),
            // Deployment owns ICE/TURN credentials; the SDK only receives an rtc factory.
            demo: {
                account: () => account,
                rtcConfiguration: () => rtcConfiguration,
                artifactOrigin,
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
        opt: demoRpcOpt,
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
    console.log(`  artifact origin: ${artifactOrigin()} (sandboxed iframe only)`)
    console.log(`  HTTP facade GET: http://localhost:${port}/http-facade/demo/status`)
    console.log(`  HTTP facade POST: http://localhost:${port}/http-facade/demo/echo  body {"args":["hello"]}`)
    console.log(`  HTTP facade auth: Authorization: Bearer ${configuredHttpFacadeToken
        ? '<DEMO_HTTP_FACADE_TOKEN> (configured)'
        : `${httpFacadeToken} (generated for this run)`}`)
    if (devModuleBridge) {
        // A failing dev module must never stop the stand from serving.
        try {
            const started = await devModuleBridge.control.start()
            console.log(`  dev module file: ${started.file}`)
            console.log(`  dev module methods: http://localhost:${port}/dev-module/methods`)
            console.log(`  dev module call: POST http://localhost:${port}/dev-module/call/greet  body "world"`)
        } catch (error) {
            console.error('[demo] dev module bridge failed to start', error)
        }
    } else {
        console.log('  dev module bridge: set DEMO_DEV_MODULE=1 to edit demo/dev-module.js live')
    }
    if (mirrorOf) console.log(`  this instance mirrors the workboard of ${mirrorOf}`)
}

void startDemo()

// ============== graceful shutdown ==============
let shuttingDown = false

function closeDemoResource(label: string, close: () => void) {
    try { close() }
    catch (error) { console.error(`[demo] ${label} close failed`, error) }
}

function closeDemoResources() {
    clearInterval(janitor)
    closeDemoResource('upstream', function closeUpstream() { upstreamLink?.close() })
    upstreamLink = null
    closeDemoResource('workboard', workboard.close)
    closeDemoResource('auth lifecycle', authLifecycle.close)
    closeDemoResource('files', files.close)
    closeDemoResource('AI', ai.close)
    closeDemoResource('artifacts', artifacts.close)
    closeDemoResource('conversations', conversations.close)
    closeDemoResource('media', media.close)
    closeDemoResource('rooms', videoRooms.close)
    closeDemoResource('calls', callPolicy.close)
    closeDemoResource('peer host', host.close)
    closeDemoResource('dev module bridge', function closeDevModuleBridge() {
        void devModuleBridge?.control.close()
    })
    uploadTickets.clear()
    uploadBytes.clear()
    artifactTickets.clear()
    artifactBytes.clear()
    commandUse.clear()
    offlineSince.clear()
    participantAccounts.clear()
}

function shutdown(signal: string) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[demo] ${signal} — closing`)
    let socketClosed = false
    let httpClosed = !httpServer.listening

    function exitWhenClosed() {
        if (!socketClosed || !httpClosed) return
        closeDemoResources()
        process.exit(0)
    }

    ioServer.close(function demoSocketsClosed() {
        socketClosed = true
        exitWhenClosed()
    })
    if (httpServer.listening) {
        httpServer.close(function demoHttpClosed() {
            httpClosed = true
            exitWhenClosed()
        })
    }
    const force = setTimeout(function exitForced() {
        closeDemoResources()
        process.exit(0)
    }, 5000)
    ;(force as any).unref?.()
}
process.once('SIGINT', function onSigint() { shutdown('SIGINT') })
process.once('SIGTERM', function onSigterm() { shutdown('SIGTERM') })
