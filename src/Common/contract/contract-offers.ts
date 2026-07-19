// =====================================================================
// Contract offer registry — discovery may add and revoke implementations
// =====================================================================

import {listen} from '../events/Listen'
import {ContractOffer} from './contract-data'

function requiredId(value: unknown, label: string) {
    if (typeof value != 'string' || !value.trim()) throw new Error('contract offers: ' + label + ' is required')
    return value.trim()
}

export function createContractOffers(initial: readonly ContractOffer[] = []) {
    const offers = new Map<string, ContractOffer>()
    const [emitChanges, changes] = listen<[readonly ContractOffer[]]>()

    function publish() {
        emitChanges(Array.from(offers.values()))
    }

    function upsert(offer: ContractOffer) {
        const id = requiredId(offer.id, 'offer id')
        const saved = {...offer, id}
        offers.set(id, saved)
        publish()
        return function removeThisOffer() {
            if (offers.get(id) != saved) return
            offers.delete(id)
            publish()
        }
    }

    function replace(next: readonly ContractOffer[]) {
        offers.clear()
        for (const offer of next) {
            const id = requiredId(offer.id, 'offer id')
            offers.set(id, {...offer, id})
        }
        publish()
    }

    replace(initial)
    return {
        control: {
            upsert,
            remove(id: string) {
                if (!offers.delete(id)) return false
                publish()
                return true
            },
            replace,
            clear() {
                if (!offers.size) return
                offers.clear()
                publish()
            },
        },
        api: {
            list: () => Array.from(offers.values()),
            changes,
        },
    }
}

export type ContractOffers = ReturnType<typeof createContractOffers>

