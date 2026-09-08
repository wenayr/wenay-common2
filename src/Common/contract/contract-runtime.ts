// =====================================================================
// Contract runtime — reconcile desired contracts to live versioned bindings
// =====================================================================
// Offers own loading/connection resources. The runtime owns compatibility,
// authority order, atomic binding replacement, leases, failure and rollback.

import {deepEqual} from '../core/common'
import {LISTEN_DISPATCH_ERROR, listen} from '../events/Listen'
import {createStore} from '../Observe/store'
import {
    ContractBinding,
    ContractBindingEvent,
    ContractCandidateStatus,
    ContractDemand,
    ContractExplanation,
    ContractLease,
    ContractOffer,
    ContractOfferSource,
    ContractPolicy,
    ContractRuntimeStatus,
    ContractSession,
    ContractSlotStatus,
    tContractSlotState,
} from './contract-data'
import {
    defaultCompareContractDemands,
    resolveContractBinding,
    validateContractDemand,
    validateContractOffer,
} from './contract-resolver'

export type ContractRuntimeDeps = {
    offers?: ContractOfferSource
    policy?: ContractPolicy
    /** Failed offers are considered again after this delay. */
    retryMs?: number
    /** Retired sessions close after leases drain or this timeout wins. */
    drainTimeoutMs?: number
    history?: number
    now?: () => number
}

type LiveBinding = {
    binding: ContractBinding
    offer: ContractOffer
    session: ContractSession
    leases: number
    retired: boolean
    draining: boolean
    closed: boolean
    offFail: any
    drainTimer: ReturnType<typeof setTimeout> | null
}

type Slot = {
    slotId: string
    state: tContractSlotState
    demand: ContractDemand | null
    active: LiveBinding | null
    previous: ContractBinding | null
    bindingGeneration: number
    candidates: ContractCandidateStatus[]
    error: string | null
}

type OfferFailure = {
    error: string
    until: number
    timer: ReturnType<typeof setTimeout> | null
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

function timer(delay: number, run: () => void) {
    const handle = setTimeout(run, delay)
    ;(handle as any).unref?.()
    return handle
}

function copyDemand(demand: ContractDemand): ContractDemand {
    return {...demand, capabilities: demand.capabilities ? [...demand.capabilities] : undefined}
}

function copyBinding(binding: ContractBinding): ContractBinding {
    return {
        ...binding,
        demand: copyDemand(binding.demand),
        descriptor: {
            ...binding.descriptor,
            capabilities: binding.descriptor.capabilities ? [...binding.descriptor.capabilities] : undefined,
        },
    }
}

function rejectedError(message: string) {
    const error = new Error(message)
    ;(error as any).contractRejected = true
    return error
}

function reportContractBindingObserverError(error: unknown) {
    setTimeout(function rethrowContractBindingObserverError() { throw error }, 0)
}

export function createContractRuntime(deps: ContractRuntimeDeps = {}) {
    const policy = deps.policy ?? {}
    const compareDemands = policy.compareDemands ?? defaultCompareContractDemands
    const retryMs = Math.max(1, deps.retryMs ?? 1000)
    const drainTimeoutMs = Math.max(0, deps.drainTimeoutMs ?? 5000)
    const historyLimit = Math.max(1, deps.history ?? 100)
    const now = deps.now ?? Date.now
    const offers = new Map<string, ContractOffer>()
    const revoked = new Map<string, string>()
    const failures = new Map<string, OfferFailure>()
    const slots = new Map<string, Slot>()
    const retired = new Set<LiveBinding>()
    const candidates = new Map<ContractSession, () => void>()
    const history: ContractBindingEvent[] = []
    const [emitBinding, bindingEvents] = listen<[ContractBindingEvent]>({
        [LISTEN_DISPATCH_ERROR]: reportContractBindingObserverError,
    })
    let closed = false
    let opChain: Promise<unknown> = Promise.resolve()

    const status = createStore<ContractRuntimeStatus>({closed: false, slots: {}})

    function assertOpen() {
        if (closed) throw new Error('contract runtime closed')
    }

    function chained<T>(run: () => Promise<T>) {
        const task = opChain.then(function runContractControl() {
            assertOpen()
            return run()
        })
        opChain = task.catch(function swallowContractControlError() {})
        return task
    }

    function slotFor(slotId: string) {
        let slot = slots.get(slotId)
        if (slot) return slot
        slot = {
            slotId,
            state: 'idle',
            demand: null,
            active: null,
            previous: null,
            bindingGeneration: 0,
            candidates: [],
            error: null,
        }
        slots.set(slotId, slot)
        return slot
    }

    function slotSnapshot(slot: Slot): ContractSlotStatus {
        return {
            slotId: slot.slotId,
            state: slot.state,
            demand: slot.demand ? copyDemand(slot.demand) : null,
            binding: slot.active ? copyBinding(slot.active.binding) : null,
            previous: slot.previous ? copyBinding(slot.previous) : null,
            candidates: slot.candidates.map(function copyCandidate(candidate) {
                return {
                    ...candidate,
                    descriptor: {
                        ...candidate.descriptor,
                        capabilities: candidate.descriptor.capabilities ? [...candidate.descriptor.capabilities] : undefined,
                    },
                }
            }),
            error: slot.error,
        }
    }

    function publishStatus() {
        const next: Record<string, ContractSlotStatus> = {}
        for (const [id, slot] of slots) next[id] = slotSnapshot(slot)
        status.replace({closed, slots: next})
    }

    function record(slot: Slot, from: ContractBinding | null, to: ContractBinding | null, reason: string, error?: unknown) {
        const event: ContractBindingEvent = {
            at: now(),
            slotId: slot.slotId,
            from: from ? copyBinding(from) : null,
            to: to ? copyBinding(to) : null,
            reason,
            ...(error != undefined ? {error: errorText(error)} : {}),
        }
        history.push(event)
        if (history.length > historyLimit) history.splice(0, history.length - historyLimit)
        emitBinding(event)
    }

    function closeCandidate(session: ContractSession) {
        const unsubscribe = candidates.get(session)
        if (!candidates.delete(session)) return
        try { unsubscribe?.() } catch {}
        try { session.close() } catch {}
    }

    function closeRetired(live: LiveBinding) {
        if (live.closed) return
        live.closed = true
        retired.delete(live)
        if (live.drainTimer) clearTimeout(live.drainTimer)
        live.drainTimer = null
        unsubscribeHandle(live.offFail)
        live.offFail = null
        try { live.session.close() } catch {}
    }

    function finishRetire(live: LiveBinding, reason?: unknown) {
        if (live.closed || live.draining) return
        live.draining = true
        let draining
        try { draining = live.session.drain?.(reason) }
        catch { closeRetired(live); return }
        Promise.resolve(draining)
            .then(function drainedContract() { closeRetired(live) },
                function failedContractDrain() { closeRetired(live) })
    }

    function retire(live: LiveBinding, reason?: unknown) {
        if (live.retired || live.closed) return
        live.retired = true
        retired.add(live)
        unsubscribeHandle(live.offFail)
        live.offFail = null
        // One deadline covers both outstanding leases and the resource's own drain.
        live.drainTimer = timer(drainTimeoutMs, function contractDrainTimedOut() {
            finishRetire(live, reason)
            closeRetired(live)
        })
        if (live.leases == 0) finishRetire(live, reason)
    }

    function clearFailure(offerId: string) {
        const failure = failures.get(offerId)
        if (!failure) return
        if (failure.timer) clearTimeout(failure.timer)
        failures.delete(offerId)
    }

    function reconcileLater() {
        if (closed) return
        void chained(async function reconcileAfterRetry() { await reconcileAll('offer retry') })
    }

    function failOffer(offerId: string, error: unknown) {
        if (closed) return
        clearFailure(offerId)
        const failure: OfferFailure = {error: errorText(error), until: now() + retryMs, timer: null}
        failure.timer = timer(retryMs, function retryContractOffer() {
            if (failures.get(offerId) != failure) return
            failures.delete(offerId)
            reconcileLater()
        })
        failures.set(offerId, failure)
    }

    function unavailable(offer: ContractOffer) {
        const revokedReason = revoked.get(offer.id)
        if (revokedReason) return 'revoked: ' + revokedReason
        const failure = failures.get(offer.id)
        if (failure && failure.until > now()) return 'temporarily failed: ' + failure.error
        if (failure) clearFailure(offer.id)
        return null
    }

    function currentOfferIs(slot: Slot, offer: ContractOffer) {
        return slot.active?.offer == offer
    }

    async function openCandidate(slot: Slot, offer: ContractOffer, reason: string) {
        assertOpen()
        const demand = slot.demand!
        slot.state = 'preparing'
        slot.error = null
        publishStatus()
        let session: ContractSession | null = null
        let offFail: any
        let live: LiveBinding | null = null
        const preparation = {failed: false, error: undefined as unknown}
        function removeFailureListener() {
            const off = offFail
            offFail = null
            unsubscribeHandle(off)
        }
        try {
            session = await offer.open({
                demand: copyDemand(demand),
                descriptor: {...offer.descriptor},
                previous: slot.active ? copyBinding(slot.active.binding) : null,
            })
            if (session && typeof session.close == 'function') candidates.set(session, removeFailureListener)
            assertOpen()
            if (!session || (typeof session.api != 'object' && typeof session.api != 'function') || session.api == null) {
                throw rejectedError('offer returned an invalid contract api')
            }
            if (typeof session.close != 'function') throw rejectedError('offer session close is required')
            // A process can fail while its asynchronous readiness policy is still running.
            offFail = session.onFail?.on(function contractSessionFailed(failureReason?: unknown) {
                const failure = failureReason ?? new Error('contract session failed')
                const active = live
                if (!active) { preparation.failed = true; preparation.error = failure; return }
                void chained(async function handleActiveContractFailure() {
                    if (closed || slot.active != active) return
                    failOffer(offer.id, failure)
                    const from = active.binding
                    slot.active = null
                    slot.error = errorText(failure)
                    slot.state = 'failed'
                    retire(active, failure)
                    record(slot, from, null, 'session failed', failure)
                    await reconcileSlot(slot, 'session failover')
                })
            })
            assertOpen()
            if (policy.acceptSession) {
                const accepted = await policy.acceptSession(demand, offer, session.api)
                assertOpen()
                if (!accepted.accepted) throw rejectedError(accepted.reason?.trim() || 'session rejected by policy')
            }
            if (preparation.failed) throw preparation.error
            if (slot.demand != demand) throw new Error('contract demand changed while candidate opened')

            clearFailure(offer.id)
            const old = slot.active
            const binding: ContractBinding = {
                slotId: slot.slotId,
                demand: copyDemand(demand),
                offerId: offer.id,
                descriptor: {
                    ...offer.descriptor,
                    capabilities: offer.descriptor.capabilities ? [...offer.descriptor.capabilities] : undefined,
                },
                bindingGeneration: ++slot.bindingGeneration,
                activatedAt: now(),
            }
            live = {
                binding,
                offer,
                session,
                leases: 0,
                retired: false,
                draining: false,
                closed: false,
                offFail,
                drainTimer: null,
            }
            assertOpen()
            candidates.delete(session)
            slot.active = live
            slot.previous = old ? copyBinding(old.binding) : slot.previous
            slot.state = 'active'
            slot.error = null
            if (old) retire(old, reason)
            assertOpen()
            record(slot, old?.binding ?? null, binding, reason)
            publishStatus()
            return {ok: true as const}
        } catch (error) {
            removeFailureListener()
            if (session) closeCandidate(session)
            assertOpen()
            const rejected = !!(error as any)?.contractRejected
            if (!rejected) failOffer(offer.id, error)
            return {ok: false as const, error, rejected}
        }
    }

    function rejectCandidate(slot: Slot, offerId: string, reason: string) {
        const candidate = slot.candidates.find(item => item.offerId == offerId)
        if (!candidate) return
        candidate.accepted = false
        candidate.reason = reason
    }

    async function reconcileSlot(slot: Slot, reason: string) {
        const demand = slot.demand
        if (!demand || closed) return
        slot.state = slot.active ? 'active' : 'resolving'
        slot.error = null
        const resolution = await resolveContractBinding({
            demand,
            offers: Array.from(offers.values()),
            policy,
            unavailable,
        })
        assertOpen()
        slot.candidates = resolution.candidates
        publishStatus()

        for (const offer of resolution.accepted) {
            if (currentOfferIs(slot, offer)) {
                slot.state = 'active'
                slot.error = null
                publishStatus()
                return
            }
            const opened = await openCandidate(slot, offer, reason)
            assertOpen()
            if (opened.ok) return
            const message = errorText(opened.error)
            rejectCandidate(slot, offer.id, opened.rejected ? message : 'open failed: ' + message)
            slot.error = message
            publishStatus()
        }

        const old = slot.active
        slot.state = demand.required == false ? 'degraded' : 'failed'
        slot.error = slot.error ?? 'no compatible contract offer'
        if (old) {
            slot.active = null
            retire(old, 'no compatible offer')
            record(slot, old.binding, null, 'no compatible offer', slot.error ?? undefined)
        }
        assertOpen()
        publishStatus()
    }

    async function reconcileAll(reason: string) {
        for (const slot of slots.values()) await reconcileSlot(slot, reason)
    }

    function replaceOfferSet(next: readonly ContractOffer[]) {
        const nextMap = new Map<string, ContractOffer>()
        for (const offer of next) {
            validateContractOffer(offer)
            if (nextMap.has(offer.id)) throw new Error('contract runtime: duplicate offer id ' + offer.id)
            nextMap.set(offer.id, offer)
        }
        for (const id of offers.keys()) if (!nextMap.has(id)) clearFailure(id)
        offers.clear()
        for (const [id, offer] of nextMap) offers.set(id, offer)
    }

    async function acceptDemand(demandValue: ContractDemand) {
        assertOpen()
        const demand = copyDemand(validateContractDemand(demandValue))
        if (policy.acceptDemand) {
            const accepted = await policy.acceptDemand(demand)
            assertOpen()
            if (!accepted.accepted) return {accepted: false, reason: accepted.reason?.trim() || 'demand rejected by policy'}
        }
        const slot = slotFor(demand.slotId)
        if (slot.demand) {
            const order = compareDemands(demand, slot.demand)
            if (order < 0) return {accepted: false, reason: 'stale demand'}
            if (order == 0) {
                if (!deepEqual(demand, slot.demand)) return {accepted: false, reason: 'conflicting demand coordinate'}
                await reconcileSlot(slot, 'demand replay')
                return {accepted: true, replay: true, status: slotSnapshot(slot)}
            }
        }
        slot.demand = demand
        slot.state = 'resolving'
        slot.error = null
        await reconcileSlot(slot, 'demand update')
        return {accepted: true, replay: false, status: slotSnapshot(slot)}
    }

    function releaseSlot(slotId: string, reason: string) {
        const slot = slots.get(slotId)
        if (!slot) return false
        const old = slot.active
        slot.active = null
        slot.demand = null
        slot.candidates = []
        slot.error = null
        slot.state = 'idle'
        if (old) {
            retire(old, reason)
            record(slot, old.binding, null, reason)
        }
        publishStatus()
        return true
    }

    async function rollbackSlot(slotId: string) {
        const slot = slots.get(slotId)
        if (!slot?.demand || !slot.previous) throw new Error('contract runtime: no previous binding for ' + slotId)
        const offer = offers.get(slot.previous.offerId)
        if (!offer) throw new Error('contract runtime: previous offer is unavailable: ' + slot.previous.offerId)
        const resolution = await resolveContractBinding({demand: slot.demand, offers: [offer], policy, unavailable})
        assertOpen()
        slot.candidates = resolution.candidates
        if (!resolution.selected) {
            publishStatus()
            throw new Error('contract runtime: previous offer is no longer compatible')
        }
        const opened = await openCandidate(slot, offer, 'rollback')
        assertOpen()
        if (!opened.ok) {
            slot.state = slot.active ? 'active' : 'failed'
            slot.error = errorText(opened.error)
            publishStatus()
            throw opened.error
        }
        return copyBinding(slot.active!.binding)
    }

    replaceOfferSet(deps.offers?.list() ?? [])
    const offSource = deps.offers?.changes.on(function contractOffersChanged(next) {
        void chained(async function applyContractOfferSource() {
            replaceOfferSet(next)
            await reconcileAll('offers changed')
        })
    })

    return {
        control: {
            require(demand: ContractDemand) {
                return chained(function requireContract() { return acceptDemand(demand) })
            },
            apply(demands: readonly ContractDemand[]) {
                return chained(async function applyContractProjection() {
                    const results = []
                    for (const demand of demands) results.push(await acceptDemand(demand))
                    return results
                })
            },
            release(slotId: string, reason = 'released') {
                return chained(async function releaseContract() { return releaseSlot(slotId, reason) })
            },
            addOffer(offer: ContractOffer) {
                return chained(async function addContractOffer() {
                    validateContractOffer(offer)
                    offers.set(offer.id, offer)
                    clearFailure(offer.id)
                    await reconcileAll('offer added')
                })
            },
            removeOffer(offerId: string) {
                return chained(async function removeContractOffer() {
                    const removed = offers.delete(offerId)
                    clearFailure(offerId)
                    if (removed) await reconcileAll('offer removed')
                    return removed
                })
            },
            replaceOffers(next: readonly ContractOffer[]) {
                return chained(async function replaceContractOffers() {
                    replaceOfferSet(next)
                    await reconcileAll('offers replaced')
                })
            },
            revokeOffer(offerId: string, reason = 'revoked') {
                return chained(async function revokeContractOffer() {
                    revoked.set(offerId, reason)
                    await reconcileAll('offer revoked')
                })
            },
            restoreOffer(offerId: string) {
                return chained(async function restoreContractOffer() {
                    const restored = revoked.delete(offerId)
                    if (restored) await reconcileAll('offer restored')
                    return restored
                })
            },
            reconcile(slotId?: string) {
                return chained(async function reconcileContracts() {
                    if (slotId) {
                        const slot = slots.get(slotId)
                        if (slot) await reconcileSlot(slot, 'manual reconcile')
                        return
                    }
                    await reconcileAll('manual reconcile')
                })
            },
            rollback(slotId: string) {
                return chained(function rollbackContract() { return rollbackSlot(slotId) })
            },
        },
        api: {
            status,
            changed: bindingEvents,
            binding(slotId: string) {
                const live = slots.get(slotId)?.active
                return live ? copyBinding(live.binding) : null
            },
            acquire<T extends object>(slotId: string): ContractLease<T> {
                if (closed) throw new Error('contract runtime closed')
                const live = slots.get(slotId)?.active
                if (!live || live.retired || live.closed) throw new Error('contract runtime: slot is not active: ' + slotId)
                live.leases++
                let released = false
                return {
                    api: live.session.api as T,
                    binding: copyBinding(live.binding),
                    release() {
                        if (released) return
                        released = true
                        live.leases--
                        if (live.retired && live.leases == 0) finishRetire(live, 'leases drained')
                    },
                }
            },
            explain(slotId: string): ContractExplanation {
                const slot = slots.get(slotId)
                if (!slot) {
                    return {slotId, demand: null, binding: null, previous: null, candidates: [], state: 'idle', error: null}
                }
                const snapshot = slotSnapshot(slot)
                return snapshot
            },
            history: () => history.map(event => ({
                ...event,
                from: event.from ? copyBinding(event.from) : null,
                to: event.to ? copyBinding(event.to) : null,
            })),
        },
        close() {
            if (closed) return
            closed = true
            unsubscribeHandle(offSource)
            for (const failure of failures.values()) if (failure.timer) clearTimeout(failure.timer)
            failures.clear()
            for (const slot of slots.values()) {
                slot.state = 'closed'
                if (slot.active) {
                    retire(slot.active, 'runtime closed')
                    slot.active = null
                }
            }
            for (const live of retired) {
                finishRetire(live, 'runtime closed')
                closeRetired(live)
            }
            for (const session of candidates.keys()) closeCandidate(session)
            bindingEvents.close()
            publishStatus()
        },
    }
}

export type ContractRuntime = ReturnType<typeof createContractRuntime>
