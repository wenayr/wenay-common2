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
import {createRpcServerAuto} from '../src/Common/rcp/rpc-server-auto'

const PORT = Number(process.env.PORT ?? 8390)

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
const uploadTickets = new Map<string, {size: number, ticket: string}>()
const uploadBytes = new Map<string, Buffer>()
let nextTicket = 0
const files = createFileJobHost({
    storage: {
        beginUpload({file}) {
            const ticket = 'demo-upload-' + (++nextTicket)
            uploadTickets.set(file.id, {size: file.size, ticket})
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
            return {url: 'http://artifact.localhost:' + PORT + '/artifact-open/' + artifact.id + '?ticket=' + ticket, expiresAt}
        },
        remove({storageKey}) {
            const key = String(storageKey)
            artifactBytes.delete(key)
            for (const [ticket, value] of artifactTickets) if (value.storageKey == key) artifactTickets.delete(ticket)
        },
    },
    drain: 'micro',
})

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
            const storageKey = 'demo-artifact-' + (++nextArtifactKey)
            artifactBytes.set(storageKey, artifactPage(prompt))
            const registered = artifacts.register({
                owner: run.owner,
                descriptor: {kind: 'demo-counter', label: 'Interactive demo counter', runtime: 'sandboxed-iframe', mime: 'text/html', version: '1'},
                storageKey,
                retention: {class: 'ephemeral', expiresAt: Date.now() + 10 * 60_000},
            })
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

// ============== media relay + call-driven watch ACL ==============
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

const callPolicy = createCallWatchPolicy()
const media = createMediaRelay({
    lines: {cam: 'video', mic: 'audio', screen: 'video'},
    canWatch: callPolicy.canWatch,
})
const host = createPeerHost({authorize: callPolicy.authorize})

// Presence cleanup retires media lines and every call/grant involving the account.
host.presence.changes.on(function onPresenceEdge(ch) {
    console.log(`[demo] presence: ${ch.account} ${ch.online ? 'online' : 'offline'}`)
    if (ch.online) return
    callPolicy.dropAccount(ch.account)
    media.dropAccount(ch.account)
})

const app = express()
app.put('/resource-upload/:fileId', express.raw({type: '*/*', limit: '100mb'}), function receiveResourceUpload(req, res) {
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
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:" + PORT,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
    })
    res.type('html').send(html)
})
app.use(express.static(path.resolve(__dirname, 'public')))
app.get('/', (_req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')))

const httpServer = createServer(app)
// screen-share JPEG frames can exceed the 1MB Socket.IO default
const ioServer = new SocketIOServer(httpServer, {maxHttpBufferSize: 1e8})

ioServer.on('connection', function onDemoConnection(socket) {
    const account = String(socket.handshake.auth?.account ?? 'anon')
    const peer = host.connection(account)
    const resource = files.connection(account)
    const aiRun = ai.connection(account)
    const artifact = artifacts.connection(account)
    const [disconnect, disconnectListen] = listen<[]>()
    socket.on('disconnect', () => { disconnect(); peer.close(); resource.close(); aiRun.close(); artifact.close() })
    createRpcServerAuto({
        socket: {emit: (key, data) => socket.emit(key, data), on: (key, cb) => socket.on(key, cb)},
        socketKey: 'app',
        object: {
            // legacy key on the SAME connection — the SDK does not displace old code
            serverTime: () => new Date().toISOString(),
            peer: peer.fragment,
            files: resource.fragment,
            ai: aiRun.fragment,
            artifacts: artifact.fragment,
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

httpServer.listen(PORT, function onDemoListen() {
    console.log('[demo] shared-cursor + calls stand is up:')
    console.log(`  tab A: http://localhost:${PORT}/?me=a&peer=b`)
    console.log(`  tab B: http://localhost:${PORT}/?me=b&peer=a`)
    console.log(`  artifact origin: http://artifact.localhost:${PORT} (sandboxed iframe only)`)
})
