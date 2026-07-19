import {listen} from '../src/Common/events/Listen'
import {createStore} from '../src/Common/Observe/store'
import {
    ContractDemand,
    ContractOffer,
    ContractRuntime,
    createContractOffers,
    createContractRuntime,
} from '../src/Common/contract/contract-index'

type DemoModuleApi = {
    id: string
    write: () => number
}

type ContractRuntimeDemoDeps = {
    element: (id: string) => HTMLElement
    log: (line: string) => void
}

const delay = (ms: number) => new Promise<void>(function wait(resolve) { setTimeout(resolve, ms) })

export function setupContractRuntimeDemo(deps: ContractRuntimeDemoDeps) {
    const {element, log} = deps
    const summary = element('contractRuntimeSummary')
    const demandBox = element('contractDemand')
    const bindingBox = element('contractBinding')
    const storeBox = element('contractStore')
    const offerBox = element('contractOffers')
    const historyBox = element('contractHistory')
    const updateButton = element('contractUpdate') as HTMLButtonElement
    const brokenButton = element('contractBroken') as HTMLButtonElement
    const requireV2Button = element('contractRequireV2') as HTMLButtonElement
    const failButton = element('contractFail') as HTMLButtonElement
    const rollbackButton = element('contractRollback') as HTMLButtonElement
    const writeButton = element('contractWrite') as HTMLButtonElement
    const resetButton = element('contractReset') as HTMLButtonElement
    const shared = createStore({value: 1, writes: 0, lastWriter: 'seed'})
    const labels: Record<string, string> = {
        builtin: 'Built-in module',
        hot: 'Downloaded v1.1',
        broken: 'Broken v1.2',
        'v2-local': 'Built-in v2 fallback',
        'v2-remote': 'Downloaded v2',
    }
    let runtime: ContractRuntime | null = null
    let offers: ReturnType<typeof createContractOffers> | null = null
    let offs: Array<() => void> = []
    let demandGeneration = 1
    let currentRange = '^1'
    let busy = false
    const liveFailures = new Map<string, Array<(reason?: unknown) => void>>()

    function descriptor(id: string, contractVersion: string) {
        return {
            protocol: 1 as const,
            contractId: 'workspace.module',
            contractVersion,
            implementationId: id,
            implementationVersion: contractVersion + '+demo.' + id,
            integrity: 'sha256:demo-' + id,
            capabilities: ['store.write', 'lifecycle.close'],
        }
    }

    function moduleOffer(
        id: string,
        contractVersion: string,
        priority: number,
        opts: {delayMs?: number, failOpen?: boolean} = {},
    ): ContractOffer<DemoModuleApi> {
        return {
            id,
            priority,
            descriptor: descriptor(id, contractVersion),
            async open() {
                await delay(opts.delayMs ?? 120)
                if (opts.failOpen) throw new Error(id + ' failed its prepare check')
                const [emitFail, onFail] = listen<[unknown?]>()
                const failures = liveFailures.get(id) ?? []
                failures.push(emitFail)
                liveFailures.set(id, failures)
                let closed = false
                return {
                    api: {
                        id,
                        write() {
                            shared.state.value++
                            shared.state.writes++
                            shared.state.lastWriter = id
                            return shared.state.value
                        },
                    },
                    onFail,
                    close() { closed = true },
                    drain() { return closed ? undefined : delay(60) },
                }
            },
        }
    }

    function demand(): ContractDemand {
        return {
            slotId: 'workspace',
            contractId: 'workspace.module',
            versionRange: currentRange,
            generation: demandGeneration,
            authorityId: 'demo-backend',
            authorityEpoch: 1,
            required: true,
            capabilities: ['store.write'],
        }
    }

    function offerCard(candidate: ReturnType<ContractRuntime['api']['explain']>['candidates'][number], activeId: string | null) {
        const card = document.createElement('article')
        card.className = 'contractOfferCard'
        const selected = candidate.offerId == activeId
        card.dataset.state = selected ? 'active' : candidate.accepted ? 'available' : 'rejected'
        const heading = document.createElement('header')
        const name = document.createElement('strong')
        name.textContent = labels[candidate.offerId] ?? candidate.offerId
        const badge = document.createElement('span')
        badge.textContent = selected ? 'ACTIVE' : candidate.accepted ? 'READY' : 'REJECTED'
        heading.append(name, badge)
        const version = document.createElement('p')
        version.textContent = `contract ${candidate.descriptor.contractVersion} · implementation ${candidate.descriptor.implementationVersion}`
        const reason = document.createElement('p')
        reason.textContent = selected ? 'selected binding generation' : candidate.reason ?? `compatible · priority ${candidate.priority}`
        card.append(heading, version, reason)
        return card
    }

    function render() {
        if (!runtime) return
        const explanation = runtime.api.explain('workspace')
        const binding = explanation.binding
        summary.textContent = `${explanation.state} · ${binding ? labels[binding.offerId] ?? binding.offerId : 'no binding'}`
        summary.dataset.state = explanation.state
        demandBox.innerHTML = '<em>1 · Desired contract</em>' +
            `<strong>${explanation.demand?.contractId ?? 'none'}</strong>` +
            `<span>${explanation.demand?.versionRange ?? '—'} · desired generation ${explanation.demand?.generation ?? '—'}</span>`
        bindingBox.innerHTML = '<em>2 · Atomic binding</em>' + (binding
            ? `<strong>${labels[binding.offerId] ?? binding.offerId}</strong>` +
              `<span>contract ${binding.descriptor.contractVersion} · binding generation ${binding.bindingGeneration}</span>`
            : `<strong>No compatible binding</strong><span>${explanation.error ?? 'waiting for a demand'}</span>`)
        storeBox.innerHTML = '<em>3 · Stable state</em>' +
            `<strong>Store value ${shared.state.value}</strong>` +
            `<span>${shared.state.writes} writes · last by ${labels[shared.state.lastWriter] ?? shared.state.lastWriter}</span>`
        offerBox.replaceChildren(...explanation.candidates.map(candidate => offerCard(candidate, binding?.offerId ?? null)))
        historyBox.replaceChildren(...runtime.api.history().slice(-6).reverse().map(function historyRow(event) {
            const row = document.createElement('div')
            row.textContent = `g${event.to?.bindingGeneration ?? '—'} · ${event.from?.offerId ?? 'none'} → ${event.to?.offerId ?? 'none'} · ${event.reason}`
            return row
        }))
        failButton.disabled = busy || !binding
        writeButton.disabled = busy || !binding
        rollbackButton.disabled = busy || !explanation.previous
        updateButton.disabled = busy || !!offers?.api.list().some(offer => offer.id == 'hot')
        brokenButton.disabled = busy || !!offers?.api.list().some(offer => offer.id == 'broken')
        requireV2Button.disabled = busy || currentRange == '^2'
    }

    async function action(label: string, run: () => Promise<void>) {
        if (busy) return
        busy = true
        render()
        try {
            await run()
            log('contract runtime: ' + label)
        } catch (error) {
            log('contract runtime: ' + label + ' failed — ' + error)
        } finally {
            busy = false
            render()
        }
    }

    async function reset() {
        for (const off of offs.splice(0)) off()
        runtime?.close()
        liveFailures.clear()
        shared.replace({value: 1, writes: 0, lastWriter: 'seed'})
        demandGeneration = 1
        currentRange = '^1'
        offers = createContractOffers([
            moduleOffer('builtin', '1.0.0', 1, {delayMs: 40}),
            moduleOffer('v2-local', '2.0.0', 1, {delayMs: 40}),
            moduleOffer('v2-remote', '2.2.0', 6, {delayMs: 260}),
        ])
        runtime = createContractRuntime({
            offers: offers.api,
            retryMs: 60_000,
            drainTimeoutMs: 1500,
            policy: {
                compatible(nextDemand, candidate) {
                    const major = nextDemand.versionRange.replace(/^\^/, '').split('.')[0]
                    return candidate.contractVersion.split('.')[0] == major
                },
            },
        })
        offs.push(runtime.api.status.listen().on(render))
        offs.push(runtime.api.changed.on(render))
        offs.push(shared.listen().on(render))
        await runtime.control.require(demand())
        render()
    }

    updateButton.addEventListener('click', function updateCompatibleModule() {
        void action('compatible v1.1 prepared and atomically activated', async function addHotOffer() {
            offers!.control.upsert(moduleOffer('hot', '1.1.0', 5, {delayMs: 320}))
            await runtime!.control.reconcile('workspace')
        })
    })
    brokenButton.addEventListener('click', function tryBrokenModule() {
        void action('broken candidate rejected; current binding kept', async function addBrokenOffer() {
            offers!.control.upsert(moduleOffer('broken', '1.2.0', 20, {delayMs: 380, failOpen: true}))
            await runtime!.control.reconcile('workspace')
        })
    })
    requireV2Button.addEventListener('click', function requireContractV2() {
        void action('backend projection moved to contract ^2', async function demandV2() {
            currentRange = '^2'
            demandGeneration++
            await runtime!.control.require(demand())
        })
    })
    failButton.addEventListener('click', function failActiveModule() {
        const activeId = runtime?.api.binding('workspace')?.offerId
        const fail = activeId ? liveFailures.get(activeId)?.at(-1) : null
        if (!fail) return
        fail(new Error(activeId + ' lost its resource'))
        log('contract runtime: active session failed; resolving fallback')
    })
    rollbackButton.addEventListener('click', function rollbackModule() {
        void action('previous compatible binding reopened as a new generation', async function rollback() {
            await runtime!.control.rollback('workspace')
        })
    })
    writeButton.addEventListener('click', function writeThroughBinding() {
        const lease = runtime?.api.acquire<DemoModuleApi>('workspace')
        if (!lease) return
        try {
            lease.api.write()
            log(`contract runtime: Store write through ${lease.binding.offerId}@g${lease.binding.bindingGeneration}`)
        } finally {
            lease.release()
        }
        render()
    })
    resetButton.addEventListener('click', function resetContractRuntime() { void reset() })
    void reset()

    return {
        close() {
            for (const off of offs.splice(0)) off()
            runtime?.close()
            runtime = null
        },
    }
}
