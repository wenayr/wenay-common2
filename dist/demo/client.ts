// Demo stand client: shared cursors over the Peer SDK — relay by default,
// "Go direct" promotes to a real RTCPeerConnection datachannel, "Back to relay"
// re-interposes. The route hand-off is gap-free by seq; the cursor never jumps.
// Plus messenger-style calls: presence shows who is online, the call button rings
// the peer over the SAME signal hub, and media (camera / mic / screen) attaches
// only while the call is active — the server's watch ACL follows the call.
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {callPortOf, createCallManager, createPeerClient} from '../src/Common/peer/peer-index'
import {attachAudioPlayer, attachVideoCanvas, createAudioSource, createVideoSource, pipeMediaPublish} from '../src/Common/media/media-index'
import {createFileJobClient} from '../src/Common/resource/resource-index'
import {createAiRunClient} from '../src/Common/ai/ai-index'
import {createArtifactClient, createArtifactFrame} from '../src/Common/artifact/artifact-index'
import {createConversationClient, tConversationBlock} from '../src/Common/conversation/conversation-index'

type World = {cursor: {x: number, y: number}, color: string, name: string}

const params = new URLSearchParams(location.search)
const me = params.get('me') ?? 'a'
const other = params.get('peer') ?? (me == 'a' ? 'b' : 'a')

const el = (id: string) => document.getElementById(id)!
const logBox = () => el('log') as HTMLDivElement

function log(line: string) {
    const box = logBox()
    const row = document.createElement('div')
    row.textContent = `${new Date().toLocaleTimeString()}  ${line}`
    box.prepend(row)
    while (box.children.length > 30) box.lastChild?.remove()
}

async function main() {
    document.title = `peer ${me}`
    el('who').textContent = `me: ${me}  ·  peer: ${other}`

    const hub = createRpcClientHub(
        () => io({transports: ['websocket'], auth: {account: me}}),
        r => ({app: r<any>('app')}) as const,
    )
    const clients = await hub.setToken(null)
    await clients.app.readyStrict()
    log('rpc connected; legacy serverTime() = ' + await clients.app.func.serverTime())
    const files = createFileJobClient({remote: clients.app.func.files, drain: 'micro'})
    await files.ready
    setupFileJobs(files)
    log('file/AI resource view ready')
    const ai = createAiRunClient({remote: clients.app.func.ai, drain: 'micro'})
    await ai.ready
    const artifacts = createArtifactClient({remote: clients.app.func.artifacts, drain: 'micro'})
    await artifacts.ready
    const artifactStand = setupArtifacts(artifacts)
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

    // ============== presence: is the peer online? ==============
    const onlineEl = el('online')
    const onlineSet = new Set<string>()
    function renderPresence() {
        const up = onlineSet.has(other)
        onlineEl.textContent = up ? `● ${other} online` : `○ ${other} offline`
        onlineEl.style.color = up ? '#2e7d32' : '#999'
    }
    // subscribe FIRST, then list() — the changes feed is a plain edge Listen
    ;(clients.app.func.peer.presence.changes as any).on((ch: any) => {
        if (ch.online) onlineSet.add(ch.account); else onlineSet.delete(ch.account)
        if (ch.account != me) log(`presence: ${ch.account} ${ch.online ? 'online' : 'offline'}`)
        renderPresence()
    })
    for (const account of await clients.app.func.peer.presence.list()) onlineSet.add(account)
    renderPresence()

    const client = createPeerClient<World>({
        remote: clients.app.func.peer,
        account: me,
        initial: {
            cursor: {x: 160, y: 120},
            color: me == 'a' ? '#4f8ef7' : '#f7a44f',
            name: me,
        },
        rtc: () => new RTCPeerConnection(),
        drain: 'micro',
    })
    const peer = client.peer(other)
    client.onRoute(ev => log(`route ${ev.key}: ${ev.from} -> ${ev.to}${ev.reason ? ` (${String(ev.reason)})` : ''}`))
    peer.ready.then(() => log('peer mirror ready (keyframe landed)')).catch(e => log('mirror error: ' + e))

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
        const theirs = peer.store.state
        if (theirs?.cursor) drawCursor(theirs.cursor, theirs.color ?? '#999', (theirs.name ?? other) + ` [${peer.route()}]`)
        el('route').textContent = `route: ${peer.route()}  ·  state: ${peer.state()}  ·  seq: ${peer.seq()}`
        requestAnimationFrame(frame)
    }
    frame()

    // ============== route controls ==============
    el('direct').addEventListener('click', async function goDirect() {
        log('promoteDirect...')
        const res = await peer.promoteDirect({timeoutMs: 8000})
        log(res.ok ? `direct: ok (${res.state})` : `direct failed: ${String(res.reason)}`)
    })
    el('relay').addEventListener('click', async function backToRelay() {
        const res = await peer.reinterposeRelay('manual')
        log(res.ok ? 'back on relay' : `re-interpose failed: ${String(res.reason)}`)
    })

    // ============== calls: ring/accept/decline over the same signal hub ==============
    const media = setupMedia(clients.app.func.media)
    const calls = createCallManager({port: callPortOf(clients.app.func.peer), self: me})
    calls.ready.then(() => log('call signaling ready'))

    const callBtn = el('call') as HTMLButtonElement
    const acceptBtn = el('accept') as HTMLButtonElement
    const declineBtn = el('decline') as HTMLButtonElement
    const callStateEl = el('callState')
    let call: any = null

    function renderCallUi() {
        const state = call?.state()
        const incoming = call?.direction == 'in' && state == 'ringing'
        callBtn.hidden = incoming
        acceptBtn.hidden = !incoming
        declineBtn.hidden = !incoming
        callBtn.textContent = state == 'active' ? '📞 hang up'
            : state == 'ringing' ? '📞 cancel…'
            : `📞 call ${other}`
        callStateEl.textContent = !call ? ''
            : state == 'ringing' ? (incoming ? `${call.peer} is calling…` : `ringing ${call.peer}…`)
            : state == 'active' ? `in call with ${call.peer}`
            : ''
    }

    function bindCall(next: any) {
        call = next
        call.changed.on(function onCallState(state: string) {
            log(`call ${state}${call?.reason() ? ` (${call.reason()})` : ''}`)
            if (state == 'active') media.attachPeer()
            if (state == 'ended') {
                media.detachPeer()
                call = null
            }
            renderCallUi()
        })
        renderCallUi()
    }

    callBtn.addEventListener('click', function onCallButton() {
        if (call) { call.hangup(); return }
        log(`calling ${other}...`)
        bindCall(calls.call(other, {kinds: ['cam', 'mic', 'screen']}))
    })
    acceptBtn.addEventListener('click', () => call?.accept())
    declineBtn.addEventListener('click', () => call?.decline())
    calls.rings.on(function onIncomingRing(incoming: any) {
        log(`incoming call from ${incoming.peer}`)
        bindCall(incoming)
    })
    renderCallUi()
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
                ? message.author.account
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
function setupArtifacts(artifacts: ReturnType<typeof createArtifactClient>) {
    const open = el('openArtifact') as HTMLButtonElement
    const revoke = el('revokeArtifact') as HTMLButtonElement
    const state = el('artifactState')
    const frame = el('artifactFrame') as HTMLIFrameElement
    const origin = location.port ? 'http://artifact.localhost:' + location.port : 'http://artifact.localhost'
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

// ============== media: capture own cam/mic/screen; watch the peer's WHILE IN CALL ==============
type tMediaKind = 'cam' | 'mic' | 'screen'

function setupMedia(media: any) {
    // -------- publish own frames through the relay (fire-and-forget) --------
    function pipePublish(kind: tMediaKind, src: any) {
        pipeMediaPublish(src[1], (frame, sentAt) => media.publish(kind, frame, sentAt), {
            onError: e => log(`media publish ${kind} failed: ${e}`),
        })
        return src
    }

    const camResEl = el('camRes') as HTMLSelectElement
    function makeCam() {
        // library fps default (3) targets machine vision; a live stand wants motion
        return pipePublish('cam', createVideoSource({sourceId: 'cam', fps: 60, width: Number(camResEl.value) || 640, codec: 'jpeg'}))
    }

    const sources = {
        cam: makeCam(),
        screen: pipePublish('screen', createVideoSource({
            sourceId: 'screen',
            fps: 10,
            codec: 'jpeg',
            quality: 0.5,            // full-screen JPEGs get large fast; favor latency
            // the documented `stream` injection point: skip getUserMedia, bring getDisplayMedia
            stream: () => (navigator.mediaDevices as any).getDisplayMedia({video: true}),
        })),
        // big buffers on purpose: the worklet's 128-sample chunks would be ~375 socket
        // messages per second and drown the shared connection (lag for everything)
        mic: pipePublish('mic', createAudioSource({sourceId: 'mic', worklet: false, bufferSize: 4096})),
    }

    // resolution stress test: swap the camera source on the fly, keep it live if it was
    camResEl.addEventListener('change', async function onCamResChange() {
        const wasLive = sources.cam.state == 'live'
        sources.cam.stop()
        sources.cam = makeCam()
        if (wasLive) {
            const state = await sources.cam.start()
            log(`cam @${camResEl.value}p: ${state}`)
        }
    })

    // -------- capture toggles --------
    function bindToggle(id: string, kind: tMediaKind, label: string) {
        const btn = el(id) as HTMLButtonElement
        btn.addEventListener('click', async function toggleCapture() {
            const src = sources[kind]
            if (src.state == 'live') {
                src.stop()
                btn.textContent = label
                log(`${kind}: stopped`)
                return
            }
            btn.textContent = `${label} …`
            const state = await src.start()
            btn.textContent = state == 'live' ? `${label} ⏹` : label
            log(`${kind}: ${state}${state != 'live' && src.getStats().error ? ' — ' + src.getStats().error : ''}`)
        })
    }
    bindToggle('cam', 'cam', '📷 camera')
    bindToggle('mic', 'mic', '🎙 mic')
    bindToggle('screen', 'screen', '🖥 screen')

    // -------- peer viewers: attached only while a call is active --------
    // The server's watch ACL denies media.watch[peer] outside a call, so the viewers
    // are created on 'active' and torn down on 'ended' (one-time DOM wiring below).
    for (const id of ['peerCam', 'peerScreen']) {
        const canvas = el(id) as HTMLCanvasElement
        canvas.addEventListener('click', function goFullscreen() {
            void (document.fullscreenElement == canvas ? document.exitFullscreen() : canvas.requestFullscreen?.())
        })
    }
    const audioBtn = el('audio') as HTMLButtonElement
    type PeerViews = {
        cam: ReturnType<typeof attachVideoCanvas>
        screen: ReturnType<typeof attachVideoCanvas>
        player: ReturnType<typeof attachAudioPlayer>
    }
    let views: PeerViews | null = null

    audioBtn.addEventListener('click', function togglePeerAudio() {
        if (!views) return
        if (views.player.enabled) {
            views.player.disable()
            audioBtn.textContent = '🔊 peer audio'
        } else {
            views.player.enable()
            audioBtn.textContent = '🔊 peer audio ⏹'
        }
    })

    function attachPeer() {
        if (views) return
        const watch = media.watch[other]
        views = {
            cam: attachVideoCanvas(watch.cam, el('peerCam'), {onError: e => log('video frame render failed: ' + e)}),
            screen: attachVideoCanvas(watch.screen, el('peerScreen'), {onError: e => log('screen frame render failed: ' + e)}),
            player: attachAudioPlayer(watch.mic, {onError: e => log('audio frame failed: ' + e)}),
        }
        audioBtn.disabled = false
        log(`watching ${other}'s media (call active)`)
    }

    function detachPeer() {
        if (!views) return
        views.cam.off()
        views.screen.off()
        views.player.disable()
        views.player.off()
        views = null
        audioBtn.disabled = true
        audioBtn.textContent = '🔊 peer audio'
        for (const id of ['peerCam', 'peerScreen']) {
            const canvas = el(id) as HTMLCanvasElement
            canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        }
        log('peer media detached (call ended)')
    }
    audioBtn.disabled = true

    // -------- stats line: own capture + helper-provided rx metrics --------
    const statsEl = el('mediaStats')
    let prevTx = {cam: 0, mic: 0, screen: 0}
    setInterval(function renderMediaStats() {
        const parts: string[] = []
        const nextTx = {cam: 0, mic: 0, screen: 0}
        for (const kind of ['cam', 'mic', 'screen'] as const) {
            const s = sources[kind].getStats()
            nextTx[kind] = s.frames
            if (s.state != 'idle') parts.push(`${kind}: ${s.state} ${s.frames}f ${s.frames - prevTx[kind]}/s${s.rms != null ? ` rms=${s.rms.toFixed(3)}` : ''}`)
        }
        prevTx = nextTx
        if (views) {
            const cam = views.cam.stats()
            const screen = views.screen.stats()
            const mic = views.player.stats()
            const caps = [['peerCam', 'peer camera', cam], ['peerScreen', 'peer screen', screen]] as const
            for (const [id, caption, s] of caps) {
                if (s.width) el(id + 'Cap').textContent = `${caption} · ${s.width}×${s.height} · click = fullscreen`
            }
            if (cam.frames || screen.frames || mic.frames) parts.push(
                `rx: cam ${cam.frames}f/${cam.drawn}d ${cam.perSec}/s ~${cam.ageMs}ms` +
                ` · screen ${screen.frames}f/${screen.drawn}d ${screen.perSec}/s ~${screen.ageMs}ms` +
                ` · mic ${mic.frames}f ${mic.perSec}/s ~${mic.ageMs}ms`)
        }
        statsEl.textContent = parts.join('  ·  ')
    }, 1000)

    return {attachPeer, detachPeer}
}

main().catch(e => { console.error(e); log('FATAL: ' + e) })
