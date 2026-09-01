// Mini horizontal scaling (browser side): this tab and every simulated reader
// are each ONE Scale.createClusterClient — the library facade owns following
// the node directory, the sticky weighted placement and the offers bridge into
// the replica set; this file keeps only the socket adapters (connect a view)
// and the scene. The route badge shows where this tab reads from.
//
// Step-3 layers in this tab:
//   identity  — Login mints ONE real codec token on the ungated main surface;
//               the same token is then presented to EVERY node in-band (HELLO)
//   writes    — go through whatever node this tab reads from, over that node's
//               GATED facade; a mini forwards the token, the leader re-verifies
//   auth log  — every node's auth stream is labeled, so revocation is VISIBLE
//               arriving from each node independently
import {io} from 'socket.io-client'
import {createRpcClientHub} from '../src/Common/rcp/rpc-clientHub'
import {createClusterClient} from '../src/Common/scale/scale-client'
import type {NodeDirectoryView} from '../src/Common/Observe/node-directory'
import {demoRpcOpt} from './protocol-schema'
import type {MiniTickState} from './mini-scale-host'

export type MiniScaleDemoDeps = {
    element: (id: string) => HTMLElement
    log: (line: string) => void
    /** clients.app.func of the main stand connection. */
    app: any
    tab: string
    /** Additive disconnect subscription of the main connection (leader session onFail). */
    onMainDisconnect: (cb: () => void) => () => void
}

export function setupMiniScaleDemo(deps: MiniScaleDemoDeps) {
    const {element, log, app, tab} = deps
    const summary = element('miniScaleSummary')
    const tickView = element('miniScaleTick')
    const routeView = element('miniScaleRoute')
    const nodesView = element('miniScaleNodes')
    const counterView = element('miniScaleCounter')
    const identityView = element('miniScaleIdentity')
    const spawnButton = element('miniScaleSpawn') as HTMLButtonElement
    const addButton = element('miniScaleAdd') as HTMLButtonElement
    const repeatButton = element('miniScaleRepeat') as HTMLButtonElement
    const loginButton = element('miniScaleLogin') as HTMLButtonElement
    const logoutButton = element('miniScaleLogout') as HTMLButtonElement
    const revokeButton = element('miniScaleRevoke') as HTMLButtonElement
    const readersButton = element('miniScaleReaders') as HTMLButtonElement
    const readersCloseButton = element('miniScaleReadersClose') as HTMLButtonElement
    const readerListView = element('miniScaleReaderList')
    const stormButton = element('miniScaleStorm') as HTMLButtonElement
    const autoscaleButton = element('miniScaleAutoscale') as HTMLButtonElement
    const sceneSvg = element('miniScaleScene') as unknown as SVGSVGElement

    // ============== identity: one session token for EVERY node ==============
    let session: {token: string, account: string, expiresAt: number} | null = null
    /** Hub token provider: connect waves present the session, notices renew it. */
    async function scaleToken({reason}: {reason: string}) {
        if (!session) return null
        if (reason == 'connect') return session.token
        try {
            const minted = await app.miniScale.identity.renew(session.token)
            session = minted
            return minted.token
        } catch (error) {
            log('mini-scale auth: renewal refused — ' + error)
            return null
        }
    }

    function watchAuth(name: string, authHub: {authListen: (cb: (event: any) => void) => () => void}) {
        return authHub.authListen(function onScaleAuthEvent(event: any) {
            const reason = event.reason != undefined ? ' (' + event.reason + ')' : ''
            log(`mini-scale auth[${name}]: ${event.state}${reason}`)
        })
    }

    // ============== the leader's GATED write surface: its own connection ==============
    const scaleHub = createRpcClientHub(
        () => io({transports: ['websocket', 'polling'], auth: {tab: tab + '-scale', role: 'scale'}}),
        r => ({scale: r<any>('scale')}) as const,
        {opt: demoRpcOpt, token: scaleToken},
    )
    watchAuth('leader', scaleHub)
    // The hub reassigns facade members on every wave (setToken), so the write
    // surface is resolved at CALL time off the stable facade — a one-shot capture
    // of wave 1 would keep a disposed client forever after logout rotates the hub
    // (and a retained .promise chain would fire unhandledrejection on close).
    let leaderLinkUp = false
    scaleHub.connectListen(function leaderLinkConnected() { leaderLinkUp = true })
    scaleHub.disconnectListen(function leaderLinkDropped() { leaderLinkUp = false })
    /** The leader's gated write surface as of NOW; null while no wave is live. */
    function leaderScale(): any {
        return leaderLinkUp ? scaleHub.facade.scale.func : null
    }

    // ============== per-node sessions: reads ungated, writes gated, same socket ==============
    // One record per mini-node session: the hub plus its link-up latch. The gated
    // write surface is resolved off hub.facade at CALL time (mirror of leaderScale),
    // so a token rotation can never leave a disposed capture behind.
    const nodeLinks = new Map<string, {hub: ReturnType<typeof createRpcClientHub>, up: boolean}>()
    /** The gated write surface of nodeId as of NOW; null while its link is down. */
    function nodeScale(nodeId: string): any {
        const link = nodeLinks.get(nodeId)
        return link?.up ? link.hub.facade.scale.func : null
    }
    async function connectNode(node: NodeDirectoryView) {
        if (node.role == 'leader') {
            return {
                remote: app.miniScale.replica,
                onFail: {on: deps.onMainDisconnect},
                close() {},
            }
        }
        const nodeHub = createRpcClientHub(
            () => io(node.url, {forceNew: true, transports: ['websocket', 'polling'], auth: {tab: tab + '-mini'}}),
            r => ({app: r<any>('app'), scale: r<any>('scale')}) as const,
            {opt: demoRpcOpt, token: scaleToken},
        )
        const link = {hub: nodeHub, up: false}
        nodeLinks.set(node.nodeId, link)
        nodeHub.connectListen(function nodeLinkConnected() { link.up = true })
        nodeHub.disconnectListen(function nodeLinkDropped() { link.up = false })
        const offAuth = watchAuth(node.nodeId, nodeHub)
        const clients = await nodeHub.promise
        await clients.app.readyStrict()
        return {
            remote: (clients.app.func as any).miniScale.replica,
            onFail: {on: (cb: () => void) => nodeHub.disconnectListen(cb)},
            close() {
                offAuth()
                // a route flap may already have replaced this entry — never delete a successor's
                if (nodeLinks.get(node.nodeId) == link) nodeLinks.delete(node.nodeId)
                // the hub's own verb: kills current AND in-flight waves, refuses resurrection
                nodeHub.close('node session closed')
            },
        }
    }

    // ============== the write path goes through WHATEVER node this tab reads from ==============
    function writeSurface() {
        const route = client.status.state.routeId
        if (route && route != 'leader') {
            const scale = nodeScale(route)
            if (scale) return {via: route, surface: scale}
        }
        return {via: 'leader', surface: leaderScale()}
    }
    let lastRequest: {requestId: string, via: string} | null = null
    async function addTen(repeat: boolean) {
        const {via, surface} = writeSurface()
        if (!surface) { log('mini-scale: the write surface is still connecting'); return }
        const requestId = repeat && lastRequest ? lastRequest.requestId
            : 'add-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        try {
            const result = await runAdd(surface, via, requestId)
            if (repeat && lastRequest) {
                log(`mini-scale: REPEATED ${lastRequest.requestId} via ${via} → value ${result.value} (receipt answered, not re-applied)`)
            } else {
                lastRequest = {requestId, via}
                log(`mini-scale: +10 via ${via} → counter ${result.value} (by ${result.by}, verified at the leader)`)
            }
        } catch (error) {
            const text = String((error as any)?.message ?? error)
            if (text.includes('Unauthorized')) log(`mini-scale: ${via} refused the write — login first (gated facade)`)
            else log('mini-scale: command failed — ' + text)
        }
    }
    /** A node mid-churn may still serve its anonymous schema; the SAME requestId is
     *  safe to retry at the leader — receipts make the cross-node retry exact-once. */
    async function runAdd(surface: any, via: string, requestId: string) {
        try {
            return await surface.commands.add(requestId, {delta: 10})
        } catch (error) {
            const text = String((error as any)?.message ?? error)
            const leader = leaderScale()
            if (via != 'leader' && leader && text.includes('Not a function')) {
                log(`mini-scale: ${via}'s gated surface is not ready (mid-churn) — retrying the SAME requestId via the leader`)
                return await leader.commands.add(requestId, {delta: 10})
            }
            throw error
        }
    }

    // ============== this tab IS one cluster client: placement + offers + line in the facade ==============
    // Sticky weighted placement lives INSIDE the library client now; this file
    // only supplies the transport adapter above. The line still moves by seq.
    const client = createClusterClient<MiniTickState>({
        storeId: 'mini-scale', originId: 'mini-scale-origin',
        nodeId: 'browser-' + tab.slice(0, 8),
        initial: {},
        directory: app.miniScale.directory,
        connect: connectNode,
        // balance: land on the emptiest node and trickle off gross overloads —
        // spawn a node and WATCH the dots flow onto it
        placement: {staleMs: 10_000, balance: {}},
        log,
    })

    // ============== simulated readers: independent lean consumers proving spread ==============
    // Each reader is a WHOLE separate cluster client: its own weighted placement
    // pick, its own directory follower, its own replica line and its own sockets
    // — so the per-node readers fact grows from REAL connections, never from
    // local math. This file supplies only the socket adapter per node view.
    const READER_CAP = 12
    const simReaders: {k: number, routeId: () => string | null, close: () => void}[] = []
    let nextReader = 0

    function spawnSimReader() {
        const k = ++nextReader
        const hubs = new Set<ReturnType<typeof createRpcClientHub>>()
        async function connectReaderNode(node: NodeDirectoryView) {
            // the leader is read through the NEW lean branch, a mini through its ungated app key;
            // both serve the same {replica, node} shape, so one session body covers both
            const hub = createRpcClientHub(
                // forceNew removes the io() manager cache from the picture entirely:
                // every reader owns its engine, proven behavior-neutral in Node
                () => node.role == 'leader'
                    ? io({forceNew: true, auth: {tab: tab + '-reader' + k, role: 'reader'}})
                    : io(node.url, {forceNew: true, transports: ['websocket', 'polling'], auth: {tab: tab + '-reader' + k, role: 'reader'}}),
                r => ({app: r<any>('app')}) as const,
                {opt: demoRpcOpt},
            )
            hubs.add(hub)
            const clients = await hub.setToken(null)
            await clients.app.readyStrict()
            return {
                remote: (clients.app.func as any).miniScale.replica,
                onFail: {on: (cb: () => void) => hub.disconnectListen(cb)},
                close() {
                    hubs.delete(hub)
                    hub.close('reader session closed')
                },
            }
        }
        const reader = createClusterClient<MiniTickState>({
            storeId: 'mini-scale', originId: 'mini-scale-origin',
            nodeId: 'browser-' + tab.slice(0, 8) + '-r' + k,
            initial: {},
            directory: app.miniScale.directory,
            connect: connectReaderNode,
            placement: {staleMs: 10_000, label: `reader #${k}`, balance: {}},
            log,
        })
        return {
            k,
            routeId: () => reader.status.state.routeId,
            close() {
                // hub.close() is the terminal verb: current AND in-flight waves die,
                // resurrection refused — no raw-socket bookkeeping needed anymore
                try { reader.close() } finally {
                    for (const hub of hubs) hub.close('reader closed')
                    hubs.clear()
                }
            },
        }
    }

    function closeSimReaders() {
        if (simReaders.length == 0) return
        for (const reader of simReaders) {
            try { reader.close() } catch (error) { log(`mini-scale: reader #${reader.k} close failed — ${error}`) }
        }
        simReaders.length = 0
        log('mini-scale: simulated readers closed')
    }

    // ============== the cluster scene: processes are boxes, readers are flying dots ==============
    // Everything drawn here is a replicated fact or a live local route — no staged
    // animation state. Dots move because their reader's route ACTUALLY moved; a box
    // turns red because the OS process ACTUALLY died. CSS transitions on transform
    // turn those fact changes into visible flight.
    type SceneDot = {id: string, kind: 'you' | 'sim' | 'anon', label: string, nodeId: string | null}
    function createClusterScene(svg: SVGSVGElement) {
        const NS = 'http://www.w3.org/2000/svg'
        const W = 920, H = 332, NODE_W = 172, NODE_H = 60, LEADER_Y = 22, MINI_Y = 172
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
        svg.setAttribute('preserveAspectRatio', 'xMidYMin meet')
        function make<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string) {
            const el = document.createElementNS(NS, tag)
            if (cls) el.setAttribute('class', cls)
            return el
        }
        const edgeLayer = make('g'), boxLayer = make('g'), dotLayer = make('g')
        svg.append(edgeLayer, boxLayer, dotLayer)

        type NodeEls = {
            root: SVGGElement, name: SVGTextElement, facts: SVGTextElement, load: SVGTextElement,
            bar: SVGRectElement, edge: SVGPathElement, badge: SVGTextElement,
        }
        const nodeEls = new Map<string, NodeEls>()
        const dotEls = new Map<string, {root: SVGGElement, num: SVGTextElement | null}>()

        function makeNodeEl(nodeId: string): NodeEls {
            const root = make('g', 'msNode') as SVGGElement
            const rect = make('rect')
            rect.setAttribute('width', String(NODE_W))
            rect.setAttribute('height', String(NODE_H))
            rect.setAttribute('rx', '12')
            const name = make('text', 'msName') as SVGTextElement
            name.setAttribute('x', String(NODE_W / 2)); name.setAttribute('y', '19')
            name.setAttribute('text-anchor', 'middle')
            const facts = make('text', 'msFacts') as SVGTextElement
            facts.setAttribute('x', String(NODE_W / 2)); facts.setAttribute('y', '33')
            facts.setAttribute('text-anchor', 'middle')
            const load = make('text', 'msFacts') as SVGTextElement
            load.setAttribute('x', String(NODE_W / 2)); load.setAttribute('y', '45')
            load.setAttribute('text-anchor', 'middle')
            const track = make('rect', 'msBarTrack')
            track.setAttribute('x', '12'); track.setAttribute('y', String(NODE_H - 9))
            track.setAttribute('width', String(NODE_W - 24)); track.setAttribute('height', '4'); track.setAttribute('rx', '2')
            const bar = make('rect', 'msBar') as SVGRectElement
            bar.setAttribute('x', '12'); bar.setAttribute('y', String(NODE_H - 9))
            bar.setAttribute('width', '0'); bar.setAttribute('height', '4'); bar.setAttribute('rx', '2')
            const badge = make('text', 'msBadge') as SVGTextElement
            badge.setAttribute('x', '10'); badge.setAttribute('y', '-6')
            const edge = make('path', 'msEdge') as SVGPathElement
            root.append(rect, name, facts, load, track, bar, badge)
            root.dataset['nodeId'] = nodeId
            edgeLayer.append(edge)
            boxLayer.append(root)
            return {root, name, facts, load, bar, edge, badge}
        }

        function retireNodeEl(nodeId: string, els: NodeEls) {
            // the process is gone: flash the box red, then let it fade out of the scene
            nodeEls.delete(nodeId)
            els.edge.remove()
            els.root.dataset['state'] = 'dead'
            els.root.classList.add('msDead')
            setTimeout(function buryNode() { els.root.remove() }, 1100)
        }

        function byNodeNumber(a: NodeDirectoryView, b: NodeDirectoryView) {
            return Number(a.nodeId.split('-')[1] ?? 0) - Number(b.nodeId.split('-')[1] ?? 0)
        }

        function render(views: NodeDirectoryView[], dots: SceneDot[], tick: string, route: string | null) {
            // fair share per node: the bar turns hot when a node grossly exceeds it,
            // which is exactly when the balance policy starts trickling readers away
            const eligibleViews = views.filter(view => view.eligible)
            const clusterLoad = eligibleViews.reduce((sum, view) => sum + Number(view.meta?.['readers'] ?? 0), 0)
            const clusterWeight = eligibleViews.reduce((sum, view) => sum + Math.max(view.weight, 0), 0)
            const leader = views.find(view => view.role == 'leader')
            const minis = views.filter(view => view.role != 'leader').sort(byNodeNumber)
            const slots = new Map<string, {x: number, y: number}>()
            if (leader) slots.set(leader.nodeId, {x: W / 2, y: LEADER_Y})
            minis.forEach(function placeMini(view, index) {
                slots.set(view.nodeId, {x: Math.round(W * (index + 1) / (minis.length + 1)), y: MINI_Y})
            })

            const seen = new Set<string>()
            for (const view of views) {
                seen.add(view.nodeId)
                let els = nodeEls.get(view.nodeId)
                if (!els) nodeEls.set(view.nodeId, els = makeNodeEl(view.nodeId))
                const slot = slots.get(view.nodeId)!
                els.root.setAttribute('transform', `translate(${slot.x - NODE_W / 2}, ${slot.y})`)
                els.root.dataset['role'] = view.role
                els.root.dataset['state'] = view.stale ? 'stale' : view.draining ? 'draining' : 'live'
                els.root.dataset['route'] = view.nodeId == route ? '1' : '0'
                els.name.textContent = (view.role == 'leader' ? '👑 ' : '') + view.nodeId
                    + (view.nodeId == route ? ' ◉' : '')
                const pid = Number(view.meta?.['pid'] ?? 0)
                let port = ''
                try { port = new URL(view.url).port } catch { port = '' }
                els.facts.textContent = (pid ? `pid ${pid}` : 'pid ?') + (port ? ` · :${port}` : '')
                const readersFact = Number(view.meta?.['readers'] ?? 0)
                els.load.textContent = view.stale ? 'process lost'
                    : view.draining ? 'draining…'
                    : `readers ${readersFact}` + (view.role == 'leader' ? ` · tick ${tick}` : ` · w${view.weight}`)
                els.bar.setAttribute('width', String(Math.round(Math.min(1, readersFact / 6) * (NODE_W - 24))))
                const fair = clusterWeight > 0 ? Math.max(clusterLoad * Math.max(view.weight, 0) / clusterWeight, 0.5) : 0.5
                els.bar.dataset['hot'] = view.eligible && readersFact > 2 * fair ? '1' : '0'
                els.badge.textContent = view.role == 'leader' && view.meta?.['autoscale'] == true ? 'AUTOSCALE' : ''
                // the replication edge: leader line → this mini, running while the node is alive
                if (view.role != 'leader' && leader) {
                    const from = slots.get(leader.nodeId)!
                    els.edge.setAttribute('d', `M ${from.x} ${from.y + NODE_H} C ${from.x} ${from.y + NODE_H + 46}, ${slot.x} ${slot.y - 46}, ${slot.x} ${slot.y}`)
                    els.edge.dataset['live'] = view.eligible ? '1' : '0'
                } else {
                    els.edge.removeAttribute('d')
                }
            }
            for (const [nodeId, els] of [...nodeEls]) if (!seen.has(nodeId)) retireNodeEl(nodeId, els)

            // -------- dots: one per reader, slotted under the node its route points at --------
            const perNode = new Map<string, number>()
            const seenDots = new Set<string>()
            for (const dot of dots) {
                seenDots.add(dot.id)
                let els = dotEls.get(dot.id)
                if (!els) {
                    const root = make('g', 'msDot') as SVGGElement
                    const circle = make('circle')
                    circle.setAttribute('r', dot.kind == 'you' ? '7' : dot.kind == 'sim' ? '5.5' : '4.5')
                    root.append(circle)
                    let num: SVGTextElement | null = null
                    if (dot.kind != 'anon') {
                        num = make('text') as SVGTextElement
                        num.setAttribute('y', dot.kind == 'you' ? '17' : '3')
                        num.setAttribute('class', dot.kind == 'you' ? 'msDotLabel' : 'msDotNum')
                        root.append(num)
                    }
                    root.dataset['kind'] = dot.kind
                    dotLayer.append(root)
                    dotEls.set(dot.id, els = {root, num})
                }
                if (els.num) els.num.textContent = dot.label
                const slot = dot.nodeId != null ? slots.get(dot.nodeId) : undefined
                if (slot) {
                    const index = perNode.get(dot.nodeId!) ?? 0
                    perNode.set(dot.nodeId!, index + 1)
                    const col = index % 8, row = Math.floor(index / 8)
                    els.root.setAttribute('transform',
                        `translate(${slot.x + (col - 3.5) * 19}, ${slot.y + NODE_H + 18 + row * 17})`)
                    els.root.dataset['lost'] = '0'
                } else {
                    // no live route: the dot waits at the edge of the scene, visibly unplaced
                    els.root.setAttribute('transform', `translate(26, ${H - 20})`)
                    els.root.dataset['lost'] = '1'
                }
            }
            for (const [id, els] of [...dotEls]) if (!seenDots.has(id)) { els.root.remove(); dotEls.delete(id) }
        }
        return {render}
    }
    const scene = createClusterScene(sceneSvg)

    /** The dots the scene draws: our own readers by route, everyone else from the replicated fact. */
    function sceneDots(views: NodeDirectoryView[], route: string | null): SceneDot[] {
        const dots: SceneDot[] = [{id: 'you', kind: 'you', label: 'you', nodeId: route}]
        for (const reader of simReaders) dots.push({id: 'r' + reader.k, kind: 'sim', label: String(reader.k), nodeId: reader.routeId()})
        // every live mini reads the leader's line itself — that cascade is not a browser reader
        const cascade = views.filter(view => view.role != 'leader' && !view.stale).length
        for (const view of views) {
            const known = dots.filter(dot => dot.nodeId == view.nodeId).length
            const fact = Number(view.meta?.['readers'] ?? 0)
            const anonymous = Math.max(0, fact - known - (view.role == 'leader' ? cascade : 0))
            for (let index = 0; index < Math.min(anonymous, 12); index++) {
                dots.push({id: `anon-${view.nodeId}-${index}`, kind: 'anon', label: '', nodeId: view.nodeId})
            }
        }
        return dots
    }

    // ============== identity controls ==============
    loginButton.addEventListener('click', async function loginMiniScale() {
        loginButton.disabled = true
        try {
            const minted = await app.miniScale.identity.login()
            session = minted
            // soft re-auth on every LIVE connection: subscriptions survive, HELLO carries the token
            const nodeHubList = [...nodeLinks.values()].map(link => link.hub)
            const presented = [scaleHub, ...nodeHubList].map(hub => hub.reauth(minted.token))
            await Promise.allSettled(presented)
            log(`mini-scale: logged in as ${minted.account} — token presented to the leader and ${nodeLinks.size} mini node(s)`)
            for (const nodeId of nodeLinks.keys()) {
                const scale = nodeScale(nodeId)
                if (!scale) continue
                void Promise.resolve(scale.whoami()).then(
                    (who: string) => log(`mini-scale: ${nodeId} verified the token locally — ${who}`),
                    () => {},
                )
            }
        } catch (error) {
            log('mini-scale: login failed — ' + error)
        } finally {
            loginButton.disabled = false
        }
    })

    logoutButton.addEventListener('click', function logoutMiniScale() {
        if (!session) { log('mini-scale: already anonymous'); return }
        session = null
        // hard rotation: a NEW wave with an explicit null token on every connection;
        // the replica line simply resumes by seq on the fresh sockets
        void scaleHub.setToken(null)
        for (const link of nodeLinks.values()) void link.hub.setToken(null)
        log('mini-scale: logged out — all connections rotated to anonymous')
    })

    revokeButton.addEventListener('click', async function revokeMiniScale() {
        const leader = leaderScale()
        if (!leader) { log('mini-scale: the leader write surface is still connecting'); return }
        revokeButton.disabled = true
        try {
            // revocation is ONE call on the LEADER; every node reacts to the replicated fact
            const result = await leader.revoke()
            session = null
            log(`mini-scale: revoked ${result.account} at the leader — watch every node cut the session`)
        } catch (error) {
            log('mini-scale: revoke failed — ' + error)
        } finally {
            revokeButton.disabled = false
        }
    })

    // ============== node controls ==============
    spawnButton.addEventListener('click', async function spawnMiniNode() {
        spawnButton.disabled = true
        try {
            const spawned = await app.miniScale.admin.spawn()
            log(`mini-scale: spawning ${spawned.nodeId}`)
        } catch (error) {
            log('mini-scale: spawn failed — ' + error)
        } finally {
            spawnButton.disabled = false
        }
    })

    addButton.addEventListener('click', function addViaMyNode() { void addTen(false) })
    repeatButton.addEventListener('click', function repeatLastRequest() {
        if (!lastRequest) { log('mini-scale: nothing to repeat yet — press +10 first'); return }
        void addTen(true)
    })

    readersButton.addEventListener('click', function addSimReaders() {
        const room = Math.min(3, READER_CAP - simReaders.length)
        for (let added = 0; added < room; added++) simReaders.push(spawnSimReader())
        log(`mini-scale: ${simReaders.length} simulated reader(s) live`)
    })
    readersCloseButton.addEventListener('click', function closeSimReadersClick() { closeSimReaders() })

    // one reader every 600ms: with autoscale on, watch the fleet grow UNDER the load
    let stormTimer: ReturnType<typeof setInterval> | null = null
    stormButton.addEventListener('click', function readerStorm() {
        if (stormTimer) return
        let room = Math.min(8, READER_CAP - simReaders.length)
        if (room <= 0) { log('mini-scale: reader cap reached — close readers first'); return }
        log(`mini-scale: reader storm — +${room} readers, one every 600ms`)
        stormTimer = setInterval(function stormTick() {
            simReaders.push(spawnSimReader())
            if (--room <= 0 || simReaders.length >= READER_CAP) {
                clearInterval(stormTimer!)
                stormTimer = null
                log(`mini-scale: storm over — ${simReaders.length} readers live`)
            }
        }, 600)
    })

    autoscaleButton.addEventListener('click', async function toggleAutoscale() {
        const leaderView = client.view.nodes().find(view => view.role == 'leader')
        const current = leaderView?.meta?.['autoscale'] == true
        autoscaleButton.disabled = true
        try {
            const result = await app.miniScale.admin.autoscale(!current)
            log(result.autoscale
                ? 'mini-scale: autoscale ON — the leader now spawns/drains processes on the readers fact'
                : 'mini-scale: autoscale OFF — the fleet is manual again')
        } catch (error) {
            log('mini-scale: autoscale toggle failed — ' + error)
        } finally {
            autoscaleButton.disabled = false
        }
    })

    async function drainNode(nodeId: string) {
        try {
            await app.miniScale.admin.drain(nodeId)
            log(`mini-scale: draining ${nodeId}`)
        } catch (error) {
            log('mini-scale: drain failed — ' + error)
        }
    }

    async function killNode(nodeId: string) {
        try {
            await app.miniScale.admin.kill(nodeId)
            log(`mini-scale: ${nodeId} killed with SIGKILL — no drain, no goodbye; watch the readers fail over`)
        } catch (error) {
            log('mini-scale: kill failed — ' + error)
        }
    }

    // ============== render loop: staleness and route are time-derived, so poll ==============
    // Everything drawn below comes off the client facade: status for the route,
    // view.nodes() for the roster the client itself places by.
    let lastRoute: string | null = null
    function render() {
        const status = client.status.state
        const views = client.view.nodes()
        const route = status.routeId
        if (route != lastRoute) {
            log(route
                ? `mini-scale: this tab now reads from ${route}`
                : 'mini-scale: no eligible node — waiting')
            lastRoute = route
        }
        tickView.textContent = String(client.store.state.tick?.value ?? '—')
        counterView.textContent = 'counter ' + String(client.store.state.counter?.value ?? 0)
        routeView.textContent = route
            ? `reading from ${route} · path ${status.path.join(' → ')}`
            : 'no route — waiting for an eligible node'
        // the autoscaler's verdict is a replicated fact off the leader row — every
        // panel can explain WHY the fleet is its current size
        const leaderNote = views.find(view => view.role == 'leader')?.meta?.['autoNote']
        summary.textContent = `${views.filter(view => view.eligible).length}/${views.length} nodes eligible`
            + (typeof leaderNote == 'string' && leaderNote ? ` · autoscale: ${leaderNote}` : '')
        if (session) {
            const left = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000))
            identityView.textContent = `${session.account} · token expires in ${left}s (auto-renews)`
        } else {
            identityView.textContent = 'anonymous — login to write'
        }
        logoutButton.disabled = !session
        revokeButton.disabled = !session
        readersButton.disabled = simReaders.length >= READER_CAP
        readersCloseButton.disabled = simReaders.length == 0
        stormButton.disabled = stormTimer != null || simReaders.length >= READER_CAP
        const autoscaleOn = views.find(view => view.role == 'leader')?.meta?.['autoscale'] == true
        autoscaleButton.textContent = autoscaleOn ? '⚡ Autoscale: on' : 'Autoscale: off'
        autoscaleButton.setAttribute('aria-pressed', String(autoscaleOn))
        autoscaleButton.classList.toggle('primary', autoscaleOn)
        // each entry is the reader's LIVE route — its own sticky pick, refreshed by seq hand-offs
        readerListView.textContent = simReaders.length
            ? 'readers: ' + simReaders.map(reader => `#${reader.k}→${reader.routeId() ?? '…'}`).join(' · ')
            : ''

        scene.render(views, sceneDots(views, route), String(client.store.state.tick?.value ?? '—'), route)

        nodesView.textContent = ''
        for (const view of views) {
            const row = document.createElement('div')
            row.className = 'miniScaleNode'
            row.dataset['state'] = view.stale ? 'stale' : view.draining ? 'draining' : 'live'
            const name = document.createElement('strong')
            name.textContent = view.nodeId + (route == view.nodeId ? ' ◉ my route' : '')
            const facts = document.createElement('span')
            // readers/pid are REPLICATED facts from the directory row, not local counts;
            // pid + port make the PROCESS nature visible: every node is a real OS process
            // with its own socket server (check the pid in Task Manager)
            const pid = Number(view.meta?.['pid'] ?? 0)
            let port = ''
            try { port = new URL(view.url).port } catch { port = '' }
            facts.textContent = `${view.role} · weight ${view.weight} · `
                + (view.stale ? 'stale' : view.draining ? 'draining' : 'live')
                + ` · readers ${Number(view.meta?.readers ?? 0)}`
                + (pid ? ` · pid ${pid}` : '')
                + (port ? ` · :${port}` : '')
            row.append(name, facts)
            if (view.role != 'leader' && !view.draining) {
                const drainButton = document.createElement('button')
                drainButton.textContent = 'Drain + stop'
                drainButton.className = 'compact'
                drainButton.title = 'Graceful: the node sees its own directory fact and exits after the grace period'
                drainButton.addEventListener('click', function drainThisNode() {
                    drainButton.disabled = true
                    void drainNode(view.nodeId)
                })
                const killButton = document.createElement('button')
                killButton.textContent = 'Kill −9'
                killButton.className = 'danger compact'
                killButton.title = 'SIGKILL the OS process — failure injection, readers fail over with no drain'
                killButton.addEventListener('click', function killThisNode() {
                    killButton.disabled = true
                    void killNode(view.nodeId)
                })
                row.append(drainButton, killButton)
            }
            nodesView.append(row)
        }
    }
    // the client facade exposes directory views as a pull (view.nodes()), not a
    // push stream — the 300ms poll below is already the pace of this panel
    const renderTimer = setInterval(render, 300)

    function close() {
        clearInterval(renderTimer)
        if (stormTimer) clearInterval(stormTimer)
        closeSimReaders()
        client.close()
        scaleHub.close('mini-scale card closed')
        for (const link of nodeLinks.values()) link.hub.close('mini-scale card closed')
        nodeLinks.clear()
    }
    return {close}
}
