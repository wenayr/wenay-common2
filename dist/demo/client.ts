// Demo stand client: shared cursors over the Peer SDK — relay by default,
// "Go direct" promotes to a real RTCPeerConnection datachannel, "Back to relay"
// re-interposes. The route hand-off is gap-free by seq; the cursor never jumps.
// Video rooms use the media socket relay; a server-owned membership policy controls
// which account lines are visible. Private calls use the same media lines with a
// separate accepted-call grant, while the cursor/data route can still go WebRTC direct.
import {io} from 'socket.io-client'
import {listen} from '../src/Common/events/Listen'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {callPortOf, createCallManager, createPeerClient} from '../src/Common/peer/peer-index'
import {createFileJobClient} from '../src/Common/resource/resource-index'
import {createAiRunClient} from '../src/Common/ai/ai-index'
import {createArtifactClient, createArtifactFrame} from '../src/Common/artifact/artifact-index'
import {createConversationClient, tConversationBlock} from '../src/Common/conversation/conversation-index'
import {setupAppShell} from './app-shell'
import {CallSession, createCallSession} from './call-app'
import {createCallTones} from './call-tones'
import {setupCallUi} from './call-ui'
import {createMediaDemo} from './media-demo'
import {setupVideoRooms} from './video-rooms-demo'
import {createWorkboardClient} from './workboard-client'
import type {WorkboardRemote} from './workboard-contract'
import {setupWorkboardDemo} from './workboard-demo'
import {setupReplicaSetDemo} from './replica-set-demo'
import {setupContractRuntimeDemo} from './contract-runtime-demo'
import {setupPacketMeshDemo} from './packet-mesh-demo'
import {createProtocolDemo} from './protocol-demo'
import {demoRpcOpt} from './protocol-schema'

type World = {
    cursor: {x: number, y: number}
    color: string
    name: string
    /** Published capture state, so peers can render "muted"/"camera off" instead of a frozen frame. */
    av?: {camOn: boolean, micOn: boolean, screenOn: boolean}
}

const tab = sessionStorage.getItem('demo-tab')
    ?? Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
sessionStorage.setItem('demo-tab', tab)
let me = ''

const el = (id: string) => document.getElementById(id)!
const logBox = () => el('log') as HTMLDivElement

function log(line: string) {
    const box = logBox()
    const row = document.createElement('div')
    row.textContent = `${new Date().toLocaleTimeString()}  ${line}`
    box.prepend(row)
    while (box.children.length > 30) box.lastChild?.remove()
}

function participantName(account: string) {
    return account.replace(/^person-/, '').toUpperCase()
}

function cleanName(value: unknown) {
    return typeof value == 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 24) : ''
}

type PeerClient = ReturnType<typeof createPeerClient<World>>
type PeerView = ReturnType<PeerClient['peer']>

async function main() {
    const shell = setupAppShell({root: document})
    const protocol = createProtocolDemo({element: el, log})
    const replicaMesh = setupReplicaSetDemo({element: el, log})
    const contractRuntime = setupContractRuntimeDemo({element: el, log})
    const packetMesh = setupPacketMeshDemo({element: el, log})
    window.addEventListener('beforeunload', replicaMesh.close)
    window.addEventListener('beforeunload', contractRuntime.close)
    window.addEventListener('beforeunload', packetMesh.close)
    const hub = createRpcClientHub(
        // Start with polling so an HTTP-only tunnel/proxy can carry RPC, then
        // Socket.IO upgrades to WebSocket whenever the external route permits it.
        () => protocol.attach(io({
            auth: {tab},
        })),
        r => ({app: r<any>('app')}) as const,
        {opt: demoRpcOpt},
    )
    const clients = await hub.setToken(null)
    await clients.app.readyStrict()
    me = await clients.app.func.demo.account()
    const rtcConfiguration = await clients.app.func.demo.rtcConfiguration() as RTCConfiguration
    const artifactOrigin = await clients.app.func.demo.artifactOrigin() as string

    // ============== identity: a display name over the account label ==============
    // The name lives in the client's own World store (like cursor and color), so
    // peers receive it through the ordinary mirror — no extra server surface.
    const peerViews = new Map<string, PeerView>()
    const onlineSet = new Set<string>()
    let myName = cleanName(sessionStorage.getItem('demo-name'))
    function displayName(account: string) {
        if (account == me) return myName || participantName(account)
        return cleanName(peerViews.get(account)?.store.state?.name) || participantName(account)
    }
    const nameInput = el('myName') as HTMLInputElement
    nameInput.value = myName
    nameInput.placeholder = `Participant ${participantName(me)}`
    document.title = `participant ${displayName(me)}`

    // ============== instance badge: which node this tab is talking to ==============
    // A mirror instance serves the same board through its cascade replay; the badge
    // shows the leader/mirror split, the line epoch and the live upstream state.
    // When the leader is gone, the badge grows a manual failover control: promote
    // raises THIS node to leader — the board keeps living, subscriptions survive.
    async function showInstanceBadge() {
        const badge = document.createElement('p')
        badge.id = 'instanceBadge'
        const promoteBtn = document.createElement('button')
        promoteBtn.id = 'promoteInstance'
        promoteBtn.textContent = '⚡ promote to leader'
        promoteBtn.hidden = true
        promoteBtn.style.cssText = 'margin-top:3px;font-size:11px;padding:2px 8px'
        const holder = document.querySelector('.brand h1')?.parentElement
        holder?.appendChild(badge)
        holder?.appendChild(promoteBtn)
        let closed = false
        let generation = 0
        let offChanged = function noInstanceChangeSubscription() {}
        let offConnect = function noInstanceReconnectSubscription() {}

        async function renderInstanceBadge(renderGeneration: number) {
            const instance = clients.app.func.demo.instance
            const role = await instance.role()
            const epoch = await instance.epoch()
            const upstream = role == 'leader' ? null : await instance.upstream()
            if (closed || generation != renderGeneration) return null
            badge.textContent = `node :${location.port || '80'} · ${role} · epoch ${epoch}`
                + (upstream && role == 'mirror' ? ` · leader ${upstream.upstream}` : '')
            promoteBtn.hidden = !(role == 'mirror' && upstream?.upstream == 'offline')
            return {instance, role}
        }

        async function reconnectInstanceBadge() {
            const reconnectGeneration = ++generation
            const rendered = await renderInstanceBadge(reconnectGeneration)
            if (!rendered || closed || generation != reconnectGeneration) return
            offChanged()
            offChanged = function noInstanceChangeSubscription() {}
            if (rendered.role == 'leader' || typeof rendered.instance.changed?.on != 'function') return
            offChanged = rendered.instance.changed.on(function upstreamEdge() {
                void renderInstanceBadge(generation)
            })
        }

        function closeInstanceBadge() {
            if (closed) return
            closed = true
            generation++
            offChanged()
            offConnect()
        }
        promoteBtn.addEventListener('click', async function promoteThisNode() {
            promoteBtn.disabled = true
            try {
                const result = await clients.app.func.demo.instance.promote()
                log(`failover: this node is now the leader (epoch ${result.epoch})`)
            } catch (error) {
                log('promote failed: ' + error)
            } finally {
                promoteBtn.disabled = false
                void reconnectInstanceBadge()
            }
        })
        try {
            await reconnectInstanceBadge()
            offConnect = hub.connectListen(function refreshInstanceAfterReconnect() {
                void reconnectInstanceBadge()
            })
            window.addEventListener('beforeunload', closeInstanceBadge, {once: true})
        } catch {
            closeInstanceBadge()
            badge.remove()
            promoteBtn.remove()
        }
    }
    void showInstanceBadge()
    const serverTime = await clients.app.func.serverTime()
    protocol.reportServerTime(serverTime)
    log('rpc connected; serverTime() = ' + serverTime)
    const workboard = createWorkboardClient({
        remote: clients.app.func.workboard as unknown as WorkboardRemote,
        drain: 'micro',
        transport: {
            connected: () => Boolean(hub.socket?.connected),
            connectListen: cb => hub.connectListen(function workboardConnected() { cb() }),
            disconnectListen: cb => hub.disconnectListen(cb),
        },
    })
    const workboardUi = setupWorkboardDemo({
        client: workboard,
        self: me,
        element: el,
        participantName: displayName,
        participants: () => Array.from(onlineSet).filter(account => account != me).sort(),
        log,
    })
    await workboard.ready
    protocol.reportStore(
        clients.app.func.workboard.state as unknown as WorkboardRemote['state'],
        workboard.status().replayMode,
    )
    log(`authoritative Workboard Store mirror ready (${workboard.status().replayMode})`)
    const files = createFileJobClient({remote: clients.app.func.files, drain: 'micro'})
    await files.ready
    setupFileJobs(files)
    log('file/AI resource view ready')
    const ai = createAiRunClient({remote: clients.app.func.ai, drain: 'micro'})
    await ai.ready
    const artifacts = createArtifactClient({remote: clients.app.func.artifacts, drain: 'micro'})
    await artifacts.ready
    const artifactStand = setupArtifacts(artifacts, artifactOrigin)
    setupAiRuns(ai, files, artifactStand)
    log('AI run view ready')
    const conversation = createConversationClient({remote: clients.app.func.conversation, drain: 'micro'})
    await conversation.ready
    setupConversation(conversation)
    log('multi-channel Conversation view ready')

    // debug tap: every signaling envelope this account receives (webrtc AND call types)
    ;(clients.app.func.peer.signal.signals as any).on((env: any) => {
        log(`sig<- ${env.type} ${env.from}->${env.to}` +
            (env.sdp ? ` sdp.len=${String(env.sdp).length}` : '') +
            (env.candidate ? ` cand=${JSON.stringify(env.candidate).slice(0, 70)}` : ''))
    })

    const client = createPeerClient<World>({
        remote: clients.app.func.peer,
        account: me,
        initial: {
            cursor: {x: 160, y: 120},
            color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
            name: myName || participantName(me),
            av: {camOn: false, micOn: false, screenOn: false},
        },
        // The deployment supplies STUN/TURN here; peer/route logic stays transport-agnostic.
        rtc: () => new RTCPeerConnection(rtcConfiguration),
        drain: 'micro',
    })
    // Own name edits publish through the store; every consumer re-renders.
    nameInput.addEventListener('change', function renameSelf() {
        myName = cleanName(nameInput.value)
        nameInput.value = myName
        sessionStorage.setItem('demo-name', myName)
        client.store.state.name = myName || participantName(me)
        document.title = `participant ${displayName(me)}`
        renderPresence()
        workboardUi.render()
        roomsUi?.rerender()
    })

    const onlineEl = el('online')
    const participantList = el('participants')
    let selectedPeer = ''
    // Created below, after media exists; presence rendering only peeks at them.
    let session: CallSession | undefined
    let callUi: {render: () => void} | undefined
    let roomsUi: {rerender: () => void} | undefined

    function selectedView() {
        return selectedPeer ? peerViews.get(selectedPeer) : undefined
    }

    function ensurePeer(account: string) {
        if (account == me) return
        const existing = peerViews.get(account)
        if (existing) return existing
        const peer = client.peer(account)
        peerViews.set(account, peer)
        // Identity and AV flags ride the same World mirror as the cursor; only
        // these keys trigger DOM re-renders (cursor stays on the RAF loop).
        peer.store.each().on(function onPeerWorldField(key: string) {
            if (key == 'name' || key == 'color') {
                renderPresence()
                workboardUi.render()
                roomsUi?.rerender()
            }
            if (key == 'av') callUi?.render()
        })
        peer.ready.then(() => log(`participant ${participantName(account)} mirror ready`)).catch(e => log('mirror error: ' + e))
        return peer
    }

    function renderPresence() {
        const accounts = Array.from(onlineSet).sort()
        const peers = accounts.filter(account => account != me)
        if (!peers.includes(selectedPeer)) selectedPeer = peers[0] ?? ''
        participantList.replaceChildren()
        for (const account of accounts) {
            if (account != me) ensurePeer(account)
            const clientButton = document.createElement('button')
            const self = account == me
            const missed = self ? 0 : session?.missedFrom(account) ?? 0
            const name = displayName(account)
            const avatar = document.createElement('span')
            avatar.className = 'chipAvatar'
            const world = self ? client.store.state : peerViews.get(account)?.store.state
            avatar.style.background = typeof world?.color == 'string' ? world.color : '#8491a1'
            avatar.textContent = (name[0] ?? '?').toUpperCase()
            const label = document.createElement('span')
            label.textContent = (self ? `You · ${name}`
                : name == participantName(account) ? `Participant ${name}` : name)
                + (missed ? ` · ${missed} missed` : '')
            clientButton.className = (self ? 'self ' : '') + (account == selectedPeer ? 'selected' : '')
            clientButton.disabled = self
            clientButton.addEventListener('click', function selectClient() {
                selectedPeer = account
                renderPresence()
                callUi?.render()
            })
            clientButton.append(avatar, label)
            participantList.append(clientButton)
        }
        onlineEl.textContent = `${accounts.length} participant(s) online`
        onlineEl.style.color = '#2e7d32'
        // Presence drives call availability too: a peer appearing/leaving must
        // refresh the call button without waiting for a chip click.
        callUi?.render()
    }
    // subscribe FIRST, then list() — the changes feed is a plain edge Listen
    const [emitPresenceEdge, presenceEdges] = listen<[{account: string, online: boolean}]>()
    ;(clients.app.func.peer.presence.changes as any).on((ch: any) => {
        if (ch.online) onlineSet.add(ch.account); else onlineSet.delete(ch.account)
        if (ch.account != me) log(`presence: ${participantName(ch.account)} ${ch.online ? 'online' : 'offline'}`)
        emitPresenceEdge({account: ch.account, online: !!ch.online})
        renderPresence()
    })
    for (const account of await clients.app.func.peer.presence.list()) onlineSet.add(account)
    renderPresence()
    el('openParticipant').addEventListener('click', function openParticipant() {
        window.open(location.href, '_blank', 'noopener')
    })

    client.onRoute(ev => log(`route ${ev.key}: ${ev.from} -> ${ev.to}${ev.reason ? ` (${String(ev.reason)})` : ''}`))

    // ============== input: own cursor -> own store ==============
    const canvas = el('canvas') as HTMLCanvasElement
    canvas.addEventListener('mousemove', function onMove(e) {
        const r = canvas.getBoundingClientRect()
        client.store.state.cursor = {x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top)}
    })

    // ============== render loop: own + mirrored cursor ==============
    const ctx = canvas.getContext('2d')!
    function drawCursor(c: {x: number, y: number}, color: string, name: string) {
        ctx.beginPath()
        ctx.arc(c.x, c.y, 8, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.fillStyle = '#333'
        ctx.font = '12px sans-serif'
        ctx.fillText(name, c.x + 12, c.y + 4)
    }
    function frame() {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const mine = client.store.state
        drawCursor(mine.cursor, mine.color, mine.name + ' (me)')
        for (const [account, peer] of peerViews) {
            const theirs = peer.store.state
            if (theirs?.cursor) drawCursor(theirs.cursor, theirs.color ?? '#999', (theirs.name ?? participantName(account)) + ` [${peer.route()}]`)
        }
        const peer = selectedView()
        el('route').textContent = peer
            ? `selected: ${participantName(selectedPeer)} · route: ${peer.route()} · state: ${peer.state()} · seq: ${peer.seq()}`
            : 'Choose another open tab to connect'
        requestAnimationFrame(frame)
    }
    frame()

    // ============== route controls ==============
    el('direct').addEventListener('click', async function goDirect() {
        const peer = selectedView()
        if (!peer) return
        log('promoteDirect...')
        const res = await peer.promoteDirect()
        log(res.ok ? `direct: ok (${res.state})` : `direct failed: ${String(res.reason)}`)
    })
    el('relay').addEventListener('click', async function backToRelay() {
        const peer = selectedView()
        if (!peer) return
        const res = await peer.reinterposeRelay('manual')
        log(res.ok ? 'back on relay' : `re-interpose failed: ${String(res.reason)}`)
    })

    // ============== rooms + private calls over the same connection ==============
    const media = createMediaDemo({
        remote: clients.app.func.media,
        self: me,
        element: el,
        log,
        participantName: displayName,
        peerAv: account => peerViews.get(account)?.store.state?.av,
    })
    roomsUi = await setupVideoRooms({
        remote: clients.app.func.demo.rooms,
        self: me,
        media: media.room,
        element: el,
        log,
        participantName: displayName,
    })
    // Peers render "muted"/"camera off" from these flags instead of guessing
    // by frame age; the same World store already carries the cursor and name.
    function publishAvState() {
        client.store.state.av = {
            camOn: media.local.state('cam') == 'live',
            micOn: media.local.state('mic') == 'live',
            screenOn: media.local.state('screen') == 'live',
        }
    }
    media.local.changes.on(function publishAvOnCapture() { publishAvState() })
    publishAvState()

    // ============== calls: session owns the rules, UI factories own the DOM ==============
    const calls = createCallManager({port: callPortOf(clients.app.func.peer), self: me})
    calls.ready.then(() => log('call signaling ready'))
    const tones = createCallTones()
    const callSession = createCallSession({
        calls,
        tones,
        media: media.call,
        capture: media.local,
        transport: {
            connectListen: cb => hub.connectListen(function callTransportConnected() { cb() }),
            disconnectListen: cb => hub.disconnectListen(cb),
        },
        presence: presenceEdges,
        log,
    })
    session = callSession
    callUi = setupCallUi({
        session: callSession,
        tones,
        capture: media.local,
        media: media.call,
        peerColor: account => peerViews.get(account)?.store.state?.color,
        onlinePeers: () => Array.from(onlineSet).filter(account => account != me).sort(),
        element: el,
        participantName: displayName,
        selectedPeer: () => selectedPeer,
        reveal: () => shell.show('rooms'),
        log,
    })
    callSession.changed.on(function onCallPhase(phase) {
        // An incoming or active call pins that participant as the selection.
        if ((phase == 'incoming' || phase == 'active') && callSession.peer()) selectedPeer = callSession.peer()
        renderPresence()
    })
    callSession.historyChanged.on(function onCallHistory() { renderPresence() })
}

// ============== Conversation: logical channels + versioned blocks + scoped facts ==============
function setupConversation(conversation: ReturnType<typeof createConversationClient>) {
    const channelBar = el('conversationChannels')
    const messages = el('conversationMessages')
    const facts = el('conversationFacts')
    const messageInput = el('conversationInput') as HTMLInputElement
    const send = el('conversationSend') as HTMLButtonElement
    const structured = el('conversationStructured') as HTMLButtonElement
    const fork = el('conversationFork') as HTMLButtonElement
    const factScope = el('conversationFactScope') as HTMLSelectElement
    const factKey = el('conversationFactKey') as HTMLInputElement
    const factValue = el('conversationFactValue') as HTMLInputElement
    const factSet = el('conversationFactSet') as HTMLButtonElement
    const factRetract = el('conversationFactRetract') as HTMLButtonElement
    let selectedConversationId: string | null = null
    let selectedChannelId: string | null = null

    function requestId(prefix: string) {
        return prefix + '-' + me + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }

    function selectedConversation() {
        return selectedConversationId ? conversation.store.state.conversations[selectedConversationId] : undefined
    }

    function selectedChannel() {
        return selectedChannelId ? conversation.store.state.channels[selectedChannelId] : undefined
    }

    function renderBlock(block: tConversationBlock) {
        const box = document.createElement('div')
        box.className = 'conversationBlock conversationBlock-' + block.kind
        if (block.kind == 'text') {
            box.textContent = block.text
            return box
        }
        if (block.kind == 'list') {
            const list = document.createElement(block.style == 'ordered' ? 'ol' : 'ul')
            for (const item of block.items) {
                const row = document.createElement('li')
                row.textContent = (block.style == 'check' ? (item.checked ? '☑ ' : '☐ ') : '') + item.text
                list.append(row)
            }
            box.append(list)
            return box
        }
        if (block.kind == 'table') {
            const table = document.createElement('table')
            const head = document.createElement('tr')
            for (const column of block.columns) {
                const cell = document.createElement('th')
                cell.textContent = column.label
                head.append(cell)
            }
            table.append(head)
            for (const value of block.rows) {
                const row = document.createElement('tr')
                for (const column of block.columns) {
                    const cell = document.createElement('td')
                    cell.textContent = String(value[column.key] ?? '')
                    row.append(cell)
                }
                table.append(row)
            }
            box.append(table)
            return box
        }
        if (block.kind == 'custom' && block.type == 'demo.metric') {
            const value = block.data as {value?: unknown, unit?: unknown}
            box.className += ' conversationMetric'
            box.textContent = String(value.value ?? '—') + ' · ' + String(value.unit ?? block.type)
            return box
        }
        if (block.kind == 'custom') {
            box.textContent = block.type + '@' + block.version + ' · ' + JSON.stringify(block.data)
            return box
        }
        if (block.kind == 'fact') box.textContent = 'fact → ' + block.factId
        if (block.kind == 'resource') box.textContent = 'resource → ' + (block.label ?? block.resourceId)
        if (block.kind == 'artifact') box.textContent = 'artifact → ' + (block.label ?? block.artifactId)
        return box
    }

    function render() {
        const available = conversation.conversations()
        if (!selectedConversation() && available[0]) selectedConversationId = available[0].id
        const currentConversation = selectedConversation()
        const availableChannels = currentConversation ? conversation.channels(currentConversation.id) : []
        if (!selectedChannel() || selectedChannel()?.conversationId != currentConversation?.id) {
            selectedChannelId = currentConversation?.rootChannelId ?? availableChannels[0]?.id ?? null
        }
        const currentChannel = selectedChannel()

        channelBar.replaceChildren()
        for (const channel of availableChannels) {
            const button = document.createElement('button')
            button.textContent = (channel.parent ? '↳ ' : '') + channel.title
            button.className = channel.id == currentChannel?.id ? 'selected' : ''
            button.addEventListener('click', function selectConversationChannel() {
                selectedChannelId = channel.id
                render()
            })
            channelBar.append(button)
        }

        messages.replaceChildren()
        const visibleMessages = currentChannel ? conversation.channelMessages(currentChannel.id) : []
        for (const message of visibleMessages) {
            const card = document.createElement('article')
            card.className = 'conversationMessage'
            const author = document.createElement('strong')
            author.textContent = message.author.kind == 'account'
                ? `Client ${participantName(message.author.account)}`
                : message.author.label ?? message.author.id
            card.append(author)
            for (const block of message.blocks) card.append(renderBlock(block))
            messages.append(card)
        }

        facts.replaceChildren()
        const visibleFacts = currentChannel ? conversation.channelFacts(currentChannel.id) : []
        for (const fact of visibleFacts) {
            const row = document.createElement('div')
            row.textContent = fact.namespace + '.' + fact.key + ' = ' + JSON.stringify(fact.value) +
                ' · r' + fact.revision + ' · ' + fact.scope.kind
            facts.append(row)
        }
        if (!visibleFacts.length) facts.textContent = 'no visible facts in this channel'

        send.disabled = !currentChannel
        structured.disabled = !currentChannel
        fork.disabled = !currentChannel || visibleMessages.length == 0
        factSet.disabled = !currentChannel
        const exactFact = currentConversation && currentChannel ? Object.values(conversation.store.state.facts).find(fact =>
            fact.conversationId == currentConversation.id && fact.namespace == 'demo' && fact.key == factKey.value &&
            (factScope.value == 'conversation' ? fact.scope.kind == 'conversation' : fact.scope.kind == 'channel' && fact.scope.channelId == currentChannel.id),
        ) : undefined
        factRetract.disabled = !exactFact || exactFact.state == 'retracted'
    }

    send.addEventListener('click', async function postConversationText() {
        const currentConversation = selectedConversation()
        const currentChannel = selectedChannel()
        if (!currentConversation || !currentChannel || !messageInput.value.trim()) return
        try {
            await conversation.postMessage({
                requestId: requestId('message'), conversationId: currentConversation.id, channelId: currentChannel.id,
                blocks: [{kind: 'text', version: 1, text: messageInput.value.trim()}],
            })
            messageInput.value = ''
        } catch (error) { log('Conversation message failed: ' + error) }
    })

    structured.addEventListener('click', async function postStructuredConversationMessage() {
        const currentConversation = selectedConversation()
        const currentChannel = selectedChannel()
        if (!currentConversation || !currentChannel) return
        try {
            await conversation.postMessage({
                requestId: requestId('structured'), conversationId: currentConversation.id, channelId: currentChannel.id,
                blocks: [
                    {kind: 'text', version: 1, text: 'Structured blocks stay declarative and renderer-local.'},
                    {kind: 'list', version: 1, style: 'ordered', items: [{text: 'text'}, {text: 'list'}, {text: 'table'}, {text: 'custom fallback'}]},
                    {kind: 'table', version: 1, columns: [{key: 'layer', label: 'Layer'}, {key: 'owner', label: 'Owner'}], rows: [
                        {layer: 'state', owner: 'Store/replay'}, {layer: 'application', owner: 'Artifact'},
                    ]},
                    {kind: 'custom', version: 1, type: 'demo.metric', data: {value: Math.floor(Math.random() * 100), unit: 'dynamic score'}},
                ],
            })
        } catch (error) { log('Conversation structured message failed: ' + error) }
    })

    fork.addEventListener('click', async function forkConversationChannel() {
        const currentConversation = selectedConversation()
        const currentChannel = selectedChannel()
        const latest = currentChannel ? conversation.channelMessages(currentChannel.id).at(-1) : undefined
        if (!currentConversation || !latest) return
        try {
            const child = await conversation.createChannel({
                requestId: requestId('fork'), conversationId: currentConversation.id,
                title: 'Thread ' + (conversation.channels(currentConversation.id).length + 1),
                parentMessageId: latest.id, factMode: 'inherit',
            })
            selectedChannelId = child.id
            render()
        } catch (error) { log('Conversation fork failed: ' + error) }
    })

    factSet.addEventListener('click', async function setConversationFact() {
        const currentConversation = selectedConversation()
        const currentChannel = selectedChannel()
        const key = factKey.value.trim()
        if (!currentConversation || !currentChannel || !key) return
        const scope = factScope.value == 'conversation' ? {kind: 'conversation'} as const : {kind: 'channel', channelId: currentChannel.id} as const
        const current = Object.values(conversation.store.state.facts).find(fact =>
            fact.conversationId == currentConversation.id && fact.namespace == 'demo' && fact.key == key &&
            (scope.kind == 'conversation' ? fact.scope.kind == 'conversation' : fact.scope.kind == 'channel' && fact.scope.channelId == scope.channelId),
        )
        try {
            await conversation.upsertFact({
                requestId: requestId('fact'), conversationId: currentConversation.id, scope,
                namespace: 'demo', key, value: factValue.value, expectedRevision: current?.revision ?? 0,
            })
        } catch (error) { log('Conversation fact failed: ' + error) }
    })

    factRetract.addEventListener('click', async function retractConversationFact() {
        const currentConversation = selectedConversation()
        const currentChannel = selectedChannel()
        if (!currentConversation || !currentChannel) return
        const current = Object.values(conversation.store.state.facts).find(fact =>
            fact.conversationId == currentConversation.id && fact.namespace == 'demo' && fact.key == factKey.value &&
            (factScope.value == 'conversation' ? fact.scope.kind == 'conversation' : fact.scope.kind == 'channel' && fact.scope.channelId == currentChannel.id),
        )
        if (!current) return
        try {
            await conversation.retractFact({
                requestId: requestId('retract'), conversationId: currentConversation.id,
                factId: current.id, expectedRevision: current.revision,
            })
        } catch (error) { log('Conversation fact retraction failed: ' + error) }
    })

    factScope.addEventListener('change', render)
    factKey.addEventListener('input', render)
    conversation.store.listen().on(render)
    conversation.events.on(function logConversationEvent(event) {
        if (event.type != 'sync') log('Conversation: ' + event.type)
    })
    render()
}

// ============== AI run protocol: state is durable; deltas are a replayed enhancement ==============
function setupAiRuns(
    ai: ReturnType<typeof createAiRunClient>,
    files: ReturnType<typeof createFileJobClient>,
    artifactStand: ReturnType<typeof setupArtifacts>,
) {
    const prompt = el('aiPrompt') as HTMLInputElement
    const start = el('startAiRun') as HTMLButtonElement
    const cancel = el('cancelAiRun') as HTMLButtonElement
    const state = el('aiRunState')
    const text = new Map<string, string>()
    let selectedId: string | null = null

    function selected() {
        return selectedId ? ai.store.state.runs[selectedId] : undefined
    }

    function render() {
        if (!selected()) selectedId = Object.keys(ai.store.state.runs).at(-1) ?? null
        const run = selected()
        const delta = run ? text.get(run.id) : undefined
        state.textContent = !run ? 'no AI run selected'
            : `${run.kind} · ${run.state} ${Math.round(run.progress * 100)}%${run.message ? ` — ${run.message}` : ''}` +
              (delta ? ` · ${delta}` : '') + ((run.result as any)?.answer ? ` · ${(run.result as any).answer}` : '')
        cancel.disabled = !run || run.state == 'completed' || run.state == 'failed' || run.state == 'cancelled'
    }

    ai.events.on(function onAiEvent(event) {
        if (event.type == 'text.delta') text.set(event.runId, (text.get(event.runId) ?? '') + event.text)
        if (event.type == 'artifact') {
            const artifactId = (event.artifact.descriptor as any)?.artifactId
            if (typeof artifactId == 'string') artifactStand.select(artifactId)
        }
        if (event.type == 'failed') log('AI run failed: ' + event.error)
        if (event.type == 'cancelled') log('AI run cancelled')
        render()
    })

    start.addEventListener('click', async function startAiRun() {
        try {
            start.disabled = true
            const latestResource = Object.values(files.store.state.files).filter(file => file.state == 'uploaded').at(-1)
            const run = await ai.createRun({
                requestId: 'demo-' + Date.now() + '-' + Math.random().toString(36).slice(2),
                kind: 'assistant',
                input: {prompt: prompt.value},
                resourceIds: latestResource ? [latestResource.id] : [],
            })
            selectedId = run.id
            render()
            log('AI run ' + run.id + ' started')
        } catch (error) {
            log('AI run failed to start: ' + error)
        } finally {
            start.disabled = false
        }
    })

    cancel.addEventListener('click', async function cancelAiRun() {
        if (!selectedId) return
        try { await ai.cancelRun(selectedId, 'demo user cancelled') }
        catch (error) { log('AI run could not cancel: ' + error) }
    })

    ai.store.listen().on(render)
    render()
}

// ============== interactive artifacts: descriptor mirror -> authorized open -> sandboxed frame ==============
function setupArtifacts(artifacts: ReturnType<typeof createArtifactClient>, origin: string) {
    const open = el('openArtifact') as HTMLButtonElement
    const revoke = el('revokeArtifact') as HTMLButtonElement
    const state = el('artifactState')
    const frame = el('artifactFrame') as HTMLIFrameElement
    const runtime = createArtifactFrame({artifacts, frame, allowedOrigins: [origin]})
    let selectedId: string | null = null

    function selected() {
        return selectedId ? artifacts.store.state.artifacts[selectedId] : undefined
    }

    function render() {
        if (!selected()) selectedId = Object.keys(artifacts.store.state.artifacts).at(-1) ?? null
        const artifact = selected()
        state.textContent = !artifact ? 'no artifact selected'
            : `${artifact.descriptor.label} · ${artifact.state} · ${artifact.retention.class}` + (artifact.retention.expiresAt ? ` · expires ${new Date(artifact.retention.expiresAt).toLocaleTimeString()}` : '')
        open.disabled = !artifact || artifact.state != 'ready' || artifact.descriptor.runtime != 'sandboxed-iframe'
        revoke.disabled = !artifact || artifact.state != 'ready'
        if (artifact?.state != 'ready') { runtime.clear(); frame.hidden = true }
    }

    async function mountArtifact() {
        if (!selectedId) return
        try {
            await runtime.mount(selectedId)
            frame.hidden = false
            log('artifact opened in a sandboxed cross-origin iframe')
        } catch (error) {
            log('artifact could not open: ' + error)
        }
    }

    async function revokeArtifact() {
        if (!selectedId) return
        try {
            await artifacts.revoke(selectedId)
            runtime.clear()
            frame.hidden = true
            log('artifact revoked; further open instructions are denied')
        } catch (error) {
            log('artifact could not revoke: ' + error)
        }
    }

    open.addEventListener('click', mountArtifact)
    revoke.addEventListener('click', revokeArtifact)
    artifacts.store.listen().on(render)
    render()
    return {
        select(artifactId: string) {
            selectedId = artifactId
            render()
        },
    }
}

// ============== file bytes by storage intent; metadata/progress by Store/replay ==============
function setupFileJobs(files: ReturnType<typeof createFileJobClient>) {
    const input = el('fileInput') as HTMLInputElement
    const uploadBtn = el('uploadFile') as HTMLButtonElement
    const processBtn = el('processFile') as HTMLButtonElement
    const download = el('downloadFile') as HTMLAnchorElement
    const state = el('fileJobState')
    let selectedId: string | null = null

    function selected() {
        return selectedId ? files.store.state.files[selectedId] : undefined
    }

    function render() {
        if (!selected() || selected()?.state == 'failed') selectedId = Object.keys(files.store.state.files)[0] ?? null
        const file = selected()
        const jobs = Object.values(files.store.state.jobs).filter(job => job.fileId == file?.id)
        const job = jobs[jobs.length - 1]
        state.textContent = !file ? 'no resource selected'
            : `${file.name} · ${file.state}` + (job ? ` · AI ${job.state} ${Math.round(job.progress * 100)}%${job.message ? ` — ${job.message}` : ''}${(job.result as any)?.summary ? ` · ${(job.result as any).summary}` : ''}` : '')
        processBtn.disabled = file?.state != 'uploaded'
        download.hidden = !file || file.state != 'uploaded'
    }

    uploadBtn.addEventListener('click', async function uploadFile() {
        const picked = input.files?.[0]
        if (!picked) { log('choose a file first'); return }
        try {
            uploadBtn.disabled = true
            const started = await files.startUpload({name: picked.name, size: picked.size, mime: picked.type || undefined})
            const intent = started.upload as {url: string, method?: string}
            const response = await fetch(intent.url, {method: intent.method ?? 'PUT', body: picked})
            if (!response.ok) throw new Error('storage upload returned ' + response.status)
            await files.confirmUpload(started.file.id)
            selectedId = started.file.id
            render()
            log('storage uploaded ' + picked.name + '; resource confirmed')
        } catch (error) {
            log('upload failed: ' + error)
        } finally {
            uploadBtn.disabled = false
        }
    })

    processBtn.addEventListener('click', async function startAiJob() {
        if (!selectedId) return
        try {
            const job = await files.startJob(selectedId, {prompt: 'demo summary'})
            log('AI job ' + job.id + ' started')
        } catch (error) {
            log('AI job failed to start: ' + error)
        }
    })

    download.addEventListener('click', async function openDownload(event) {
        if (!selectedId) return
        event.preventDefault()
        try {
            const intent = await files.download(selectedId) as {url: string}
            window.open(intent.url, '_blank', 'noopener')
        } catch (error) {
            log('download unavailable: ' + error)
        }
    })

    files.store.listen().on(render)
    render()
}

main().catch(e => { console.error(e); log('FATAL: ' + e) })
