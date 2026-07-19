import {createStoreReplicaSet, StoreReplicaOffer, StoreReplicaSet} from '../src/Common/Observe/store-replica-set'

type MeshItem = {id: string, value: number, writer: string, revision: number}
type MeshState = Record<string, MeshItem>

type MeshNode = {
    id: string
    label: string
    replica: StoreReplicaSet<MeshState>
}

type MeshLink = ReturnType<typeof createMeshLink>

type ReplicaSetDemoDeps = {
    element: (id: string) => HTMLElement
    log: (line: string) => void
}

const delay = (ms: number) => new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })

// =====================================================================
// SVG network diagram utilities
// =====================================================================

type GraphPoint = {x: number, y: number}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag) as SVGElementTagNameMap[K]
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
    return element
}

function curveBetween(from: GraphPoint, to: GraphPoint, offset: number) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.max(1, Math.hypot(dx, dy))
    const middleX = (from.x + to.x) / 2 - dy / length * offset
    const middleY = (from.y + to.y) / 2 + dx / length * offset
    return `M ${from.x} ${from.y} Q ${middleX} ${middleY} ${to.x} ${to.y}`
}

function arrowBetween(from: GraphPoint, to: GraphPoint, trim = 42) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.max(1, Math.hypot(dx, dy))
    return `M ${from.x + dx / length * trim} ${from.y + dy / length * trim} ` +
        `L ${to.x - dx / length * trim} ${to.y - dy / length * trim}`
}

function createMeshLink(from: MeshNode, to: MeshNode, kind: 'direct' | 'relay', initialLatency: number) {
    const id = `${kind}:${from.id}->${to.id}`
    let enabled = true
    let latency = initialLatency
    const sessions = new Set<{fail: (reason?: unknown) => void}>()

    const offer: StoreReplicaOffer = {
        id,
        async connect() {
            if (!enabled) throw new Error(id + ' unavailable')
            let closed = false
            const failCbs = new Set<(reason?: unknown) => void>()
            const session = {
                fail(reason?: unknown) {
                    if (closed) return
                    for (const cb of Array.from(failCbs)) cb(reason)
                },
            }
            sessions.add(session)
            return {
                remote: {
                    descriptor: to.replica.api.fragment.descriptor,
                    changed: to.replica.api.fragment.changed,
                    replay: to.replica.api.fragment.replay,
                    async ping() { await delay(latency) },
                },
                onFail: {
                    on(cb: (reason?: unknown) => void) {
                        failCbs.add(cb)
                        return function stopWatchingMeshLink() { failCbs.delete(cb) }
                    },
                },
                close() {
                    if (closed) return
                    closed = true
                    failCbs.clear()
                    sessions.delete(session)
                },
            }
        },
    }

    from.replica.control.addOffer(offer)
    return {
        id,
        from: from.id,
        to: to.id,
        kind,
        offer,
        enabled: () => enabled,
        latency: () => latency,
        setLatency(value: number) { latency = value },
        setEnabled(value: boolean) {
            if (enabled == value) return
            enabled = value
            if (!value) {
                for (const session of Array.from(sessions)) session.fail(new Error(id + ' partitioned'))
            } else {
                void from.replica.control.probe().catch(function ignoreReconnectRace() {})
            }
        },
    }
}

export function setupReplicaSetDemo(deps: ReplicaSetDemoDeps) {
    const {element, log} = deps
    const nodeBox = element('replicaMeshNodes')
    const graph = element('replicaMeshGraph') as unknown as SVGSVGElement
    const summary = element('replicaMeshSummary')
    const eventBox = element('replicaMeshEvents')
    const offerCount = element('replicaOfferCount')
    const sessionCount = element('replicaSessionCount')
    const routeCount = element('replicaRouteCount')
    const writeButton = element('replicaMeshWrite') as HTMLButtonElement
    const routeButton = element('replicaMeshRoutes') as HTMLButtonElement
    const failButton = element('replicaMeshFail') as HTMLButtonElement
    const splitButton = element('replicaMeshSplit') as HTMLButtonElement
    const forkButton = element('replicaMeshFork') as HTMLButtonElement
    const mergeButton = element('replicaMeshMerge') as HTMLButtonElement
    const resetButton = element('replicaMeshReset') as HTMLButtonElement
    const eventLines: string[] = []
    let nodes: MeshNode[] = []
    let links: MeshLink[] = []
    let offs: Array<() => void> = []
    let counter = 0
    let relayFast = false
    let scenario = 'forming the mesh'
    let renderQueued = false

    function note(line: string) {
        eventLines.unshift(`${new Date().toLocaleTimeString()} · ${line}`)
        if (eventLines.length > 9) eventLines.pop()
        eventBox.replaceChildren(...eventLines.map(function eventRow(text) {
            const row = document.createElement('div')
            row.textContent = text
            return row
        }))
    }

    function queueRender() {
        if (renderQueued) return
        renderQueued = true
        requestAnimationFrame(function paintReplicaMesh() {
            renderQueued = false
            render()
        })
    }

    function nodeCard(node: MeshNode) {
        const status = node.replica.api.status.state
        const card = document.createElement('article')
        card.className = 'replicaNode'
        card.dataset.role = status.role
        card.dataset.node = node.id
        const heading = document.createElement('header')
        const label = document.createElement('strong')
        label.textContent = node.label
        const role = document.createElement('span')
        role.className = 'statusBadge'
        role.dataset.state = status.role == 'leader' ? 'live' : status.role
        role.textContent = status.role
        heading.append(label, role)
        const authority = document.createElement('p')
        authority.textContent = `leader ${status.leaderId ?? '—'} · epoch ${status.epoch}`
        const route = document.createElement('p')
        route.textContent = status.routeId
            ? `${status.routeId} · ${Math.round(status.authorityCost ?? status.rtt ?? 0)} ms total`
            : 'local copy · no upstream route'
        const path = document.createElement('p')
        path.textContent = 'path ' + (status.path.length ? status.path.join(' → ') : '—')
        const data = document.createElement('p')
        data.textContent = `${Object.keys(node.replica.api.store.state).length} keys · ${status.conflicts} conflicts`
        card.append(heading, authority, route, path, data)
        return card
    }

    function graphPositions(width: number, height: number) {
        const compact = width < 520
        const left = width * (compact ? .25 : .18)
        const right = width * (compact ? .75 : .82)
        const top = compact ? 82 : 72
        const bottom = height - (compact ? 82 : 72)
        return new Map<string, GraphPoint>([
            ['alpha', {x: left, y: top}],
            ['beta', {x: right, y: top}],
            ['gamma', {x: left, y: bottom}],
            ['client', {x: right, y: bottom}],
        ])
    }

    function graphDefinitions() {
        const definitions = svgElement('defs')
        const marker = svgElement('marker', {
            id: 'replicaRouteArrow',
            viewBox: '0 0 10 10',
            refX: 8,
            refY: 5,
            markerWidth: 8,
            markerHeight: 8,
            orient: 'auto-start-reverse',
        })
        const arrow = svgElement('path', {d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--success)'})
        marker.append(arrow)
        definitions.append(marker)
        return definitions
    }

    function renderGraph() {
        const width = Math.max(300, Math.round(graph.getBoundingClientRect().width || 900))
        const height = width < 520 ? 420 : 320
        const positions = graphPositions(width, height)
        graph.setAttribute('viewBox', `0 0 ${width} ${height}`)
        graph.setAttribute('height', String(height))

        const offerLayer = svgElement('g', {'aria-label': 'Connection capabilities'})
        for (let fromIndex = 0; fromIndex < nodes.length; fromIndex++) {
            for (let toIndex = fromIndex + 1; toIndex < nodes.length; toIndex++) {
                const from = nodes[fromIndex]
                const to = nodes[toIndex]
                const fromPoint = positions.get(from.id)
                const toPoint = positions.get(to.id)
                if (!fromPoint || !toPoint) continue
                for (const kind of ['direct', 'relay'] as const) {
                    const pair = links.filter(function linkConnectsPair(link) {
                        return link.kind == kind &&
                            ((link.from == from.id && link.to == to.id) || (link.from == to.id && link.to == from.id))
                    })
                    const available = pair.length == 2 && pair.every(link => link.enabled())
                    offerLayer.append(svgElement('path', {
                        class: 'graphOffer',
                        d: curveBetween(fromPoint, toPoint, kind == 'direct' ? -8 : 8),
                        'data-kind': kind,
                        'data-enabled': String(available),
                    }))
                }
            }
        }

        const routeLayer = svgElement('g', {'aria-label': 'Selected Store replay routes'})
        for (const node of nodes) {
            const status = node.replica.api.status.state
            const fromPoint = status.routeNodeId ? positions.get(status.routeNodeId) : null
            const toPoint = positions.get(node.id)
            if (!fromPoint || !toPoint || !status.routeId) continue
            routeLayer.append(svgElement('path', {
                class: 'graphRoute',
                d: arrowBetween(fromPoint, toPoint),
                'data-kind': status.routeId.startsWith('relay:') ? 'relay' : 'direct',
            }))
        }

        const nodeLayer = svgElement('g', {'aria-label': 'Replica nodes'})
        for (const node of nodes) {
            const point = positions.get(node.id)
            if (!point) continue
            const status = node.replica.api.status.state
            const group = svgElement('g', {
                class: 'graphNode',
                transform: `translate(${point.x} ${point.y})`,
                'data-role': status.role,
            })
            const title = svgElement('title')
            title.textContent = `${node.label}: ${status.role}, leader ${status.leaderId ?? 'none'}, epoch ${status.epoch}`
            const circle = svgElement('circle', {r: 38})
            const name = svgElement('text', {class: 'graphNodeName', y: -5})
            name.textContent = node.id
            const role = svgElement('text', {class: 'graphNodeRole', y: 13})
            role.textContent = `${status.role} · e${status.epoch}`
            const cost = svgElement('text', {class: 'graphNodeCost', y: 54})
            cost.textContent = status.role == 'leader'
                ? 'authority'
                : status.authorityCost == null ? 'no live route' : `${Math.round(status.authorityCost)} ms total`
            group.append(title, circle, name, role, cost)
            nodeLayer.append(group)
        }

        graph.replaceChildren(graphDefinitions(), offerLayer, routeLayer, nodeLayer)
        const activeRoutes = nodes.filter(node => node.replica.api.status.state.routeId != null).length
        graph.setAttribute('aria-label', `${links.filter(link => link.enabled()).length} available connection offers, ` +
            `${activeRoutes} selected Store replay routes, ` +
            `${nodes.filter(node => node.replica.api.canWrite()).length} leaders`)
    }

    function render() {
        nodeBox.replaceChildren(...nodes.map(nodeCard))
        const leaders = nodes.filter(node => node.replica.api.canWrite()).map(node => node.id)
        const liveLinks = links.filter(link => link.enabled()).length
        const openSessions = nodes.reduce(function countOpenSessions(total, node) {
            return total + Object.values(node.replica.api.status.state.routes).filter(route => route.state == 'open').length
        }, 0)
        const selectedRoutes = nodes.filter(node => node.replica.api.status.state.routeId != null).length
        offerCount.textContent = `${liveLinks}/${links.length}`
        sessionCount.textContent = String(openSessions)
        routeCount.textContent = String(selectedRoutes)
        summary.textContent = `${scenario} · leaders ${leaders.join(', ') || 'none'} · ${liveLinks}/${links.length} route offers available`
        forkButton.disabled = leaders.length < 2
        mergeButton.disabled = links.every(link => link.enabled())
        renderGraph()
    }

    function createNode(id: string, label: string, leader = false, eligible = true) {
        const replica = createStoreReplicaSet<MeshState>({
            storeId: 'mesh-board',
            originId: 'mesh-board-origin',
            nodeId: id,
            lineId: id + '-browser-line',
            initial: leader ? {welcome: {id: 'welcome', value: 1, writer: id, revision: 1}} : {},
            expose: {history: 200},
            leadership: {
                initialRole: leader ? 'leader' : 'follower',
                epoch: leader ? 1 : 0,
                eligible,
                autoPromoteMs: 450,
            },
            route: {
                reconnectMs: 180,
                pingTimeoutMs: 300,
                probeIntervalMs: 900,
                hysteresisMs: 4,
            },
        })
        return {id, label, replica}
    }

    function connectMesh() {
        for (const from of nodes) {
            for (const to of nodes) {
                if (from == to) continue
                const salt = from.id.charCodeAt(0) + to.id.charCodeAt(0)
                links.push(createMeshLink(from, to, 'direct', 7 + salt % 7))
                links.push(createMeshLink(from, to, 'relay', 32 + salt % 13))
            }
        }
    }

    function watchNode(node: MeshNode) {
        offs.push(node.replica.api.status.listen().on(queueRender))
        offs.push(node.replica.api.store.listen().on(queueRender))
        offs.push(node.replica.api.conflicts.on(function meshConflict(event) {
            const localKeys = event.diff.localOnly.length
            const sameKeys = event.diff.conflicts.length
            note(`${node.id} adopted ${event.authority.leaderId}@${event.authority.epoch}; preserved ${localKeys} local-only and ${sameKeys} conflicting keys`)
            log(`replica mesh: ${node.id} reconciled a fork with ${event.authority.leaderId}`)
            queueRender()
        }))
        offs.push(node.replica.api.routes.on(function meshRouteChanged(event) {
            if (event.from == event.to) return
            note(`${node.id}: ${event.from ?? 'local'} → ${event.to ?? 'local'} (${event.reason})`)
            queueRender()
        }))
    }

    async function reset() {
        for (const off of offs.splice(0)) off()
        for (const node of nodes) node.replica.close()
        nodes = [
            createNode('alpha', 'Alpha · server', true),
            createNode('beta', 'Beta · server'),
            createNode('gamma', 'Gamma · edge'),
            createNode('client', 'Client · browser', false, false),
        ]
        links = []
        eventLines.length = 0
        counter = 0
        relayFast = false
        scenario = 'forming the mesh'
        for (const node of nodes) watchNode(node)
        connectMesh()
        queueRender()
        await Promise.all(nodes.map(node => node.replica.api.ready))
        scenario = 'one logical Store across servers, edge and browser'
        note('mesh formed; client participates as a non-electable replica')
        queueRender()
    }

    function leaders() {
        return nodes.filter(node => node.replica.api.canWrite())
    }

    function writeOn(node: MeshNode, key: string, value: number) {
        const previous = node.replica.control.store.state[key]
        node.replica.control.store.state[key] = {
            id: key,
            value,
            writer: node.id,
            revision: (previous?.revision ?? 0) + 1,
        }
    }

    writeButton.addEventListener('click', function writeReplicaMesh() {
        counter++
        const current = leaders()
        if (!current.length) { note('write paused: no elected leader'); return }
        for (const node of current) writeOn(node, 'pulse-' + counter, counter)
        note(`write ${counter} accepted by ${current.map(node => node.id).join(', ')}`)
        queueRender()
    })

    routeButton.addEventListener('click', async function swapReplicaRouteLatency() {
        relayFast = !relayFast
        for (const link of links) {
            const salt = link.from.charCodeAt(0) + link.to.charCodeAt(0)
            link.setLatency(link.kind == (relayFast ? 'relay' : 'direct') ? 6 + salt % 5 : 48 + salt % 11)
        }
        scenario = relayFast ? 'relay paths are currently shorter' : 'direct paths are currently shorter'
        note('latency map changed; probes are selecting new routes with hysteresis')
        for (let sample = 0; sample < 4; sample++) await Promise.all(nodes.map(node => node.replica.control.probe()))
        queueRender()
    })

    failButton.addEventListener('click', function isolateReplicaLeader() {
        const target = leaders()[0]
        if (!target) { note('no leader to isolate'); return }
        for (const link of links) {
            if (link.from == target.id || link.to == target.id) link.setEnabled(false)
        }
        scenario = `${target.id} isolated; remaining component is electing`
        note(`${target.id} lost every route; its old copy remains readable while the other component elects`)
        queueRender()
    })

    splitButton.addEventListener('click', function splitReplicaMesh() {
        const left = new Set(['alpha', 'beta'])
        for (const link of links) link.setEnabled(left.has(link.from) == left.has(link.to))
        scenario = 'partitioned into alpha+beta and gamma+client'
        note('network split: each component keeps local reads; eligible components may elect a boss')
        queueRender()
    })

    forkButton.addEventListener('click', function writeReplicaForks() {
        counter++
        const current = leaders()
        if (current.length < 2) { note('wait until both partitions have a leader'); return }
        for (const [index, node] of current.entries()) {
            writeOn(node, 'shared', counter * 10 + index)
            writeOn(node, `only-${node.id}-${counter}`, counter)
        }
        note(`both partitions wrote key “shared” differently (${current.map(node => node.id).join(' vs ')})`)
        queueRender()
    })

    mergeButton.addEventListener('click', async function mergeReplicaMesh() {
        for (const link of links) link.setEnabled(true)
        scenario = 'merging partitions and choosing the canonical authority'
        note('all connection offers restored; epoch then node id selects the winner')
        await Promise.all(nodes.map(node => node.replica.control.probe()))
        queueRender()
    })

    resetButton.addEventListener('click', function resetReplicaMesh() { void reset() })
    const graphObserver = typeof ResizeObserver == 'function' ? new ResizeObserver(queueRender) : null
    graphObserver?.observe(graph)
    window.addEventListener('resize', queueRender)
    void reset()

    return {
        close() {
            graphObserver?.disconnect()
            window.removeEventListener('resize', queueRender)
            for (const off of offs.splice(0)) off()
            for (const node of nodes) node.replica.close()
            nodes = []
            links = []
            graph.replaceChildren()
        },
    }
}
