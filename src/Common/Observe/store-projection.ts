// =====================================================================
// Projected Store reconciliation — write only records that really changed
// =====================================================================

import {compareDeepValues} from '../core/deep-equal'
import {cloneStoreValue, Store, StoreChange} from './store'
import {toRaw} from './reactive'

function owns(value: object, key: PropertyKey) {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    if (value == null || typeof value != 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype == null || prototype == Object.prototype
}

function defineProjectionValue(target: object, key: PropertyKey, value: unknown) {
    const defined = Reflect.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    })
    if (!defined) throw new TypeError('store projection cannot define key: ' + String(key))
}

/** Detach opaque projected data from the authority's reactive object graph. */
export function cloneStoreProjectionValue<T>(value: T): T {
    return cloneStoreValue(value)
}

/**
 * Reconcile record-shaped projections without replacing their top-level maps.
 * Fresh projection copies are common at authorization boundaries; assigning them
 * wholesale would manufacture patches for every connection even when the visible
 * data stayed equal.
 */
export function reconcileStoreProjection<T extends object>(store: Store<T>, next: T) {
    const current = toRaw(store.state) as Record<PropertyKey, unknown>
    const target = store.state as Record<PropertyKey, any>
    let writes = 0

    for (const key of Reflect.ownKeys(current)) {
        if (owns(next, key)) continue
        delete target[key]
        writes++
    }
    for (const key of Reflect.ownKeys(next)) {
        const nextValue = (next as Record<PropertyKey, unknown>)[key]
        const currentValue = current[key]
        if (!isRecord(currentValue) || !isRecord(nextValue)) {
            if (compareDeepValues(currentValue, nextValue)) continue
            defineProjectionValue(target, key, nextValue)
            writes++
            continue
        }
        const collection = target[key] as Record<PropertyKey, unknown>
        for (const itemKey of Reflect.ownKeys(currentValue)) {
            if (owns(nextValue, itemKey)) continue
            delete collection[itemKey]
            writes++
        }
        for (const itemKey of Reflect.ownKeys(nextValue)) {
            const item = nextValue[itemKey]
            if (owns(currentValue, itemKey) && compareDeepValues(currentValue[itemKey], item)) continue
            defineProjectionValue(collection, itemKey, item)
            writes++
        }
    }
    return writes
}

export function collectStoreProjectionChanges(change: StoreChange, collections: readonly PropertyKey[]) {
    const allowed = new Set(collections)
    const changed = new Map<PropertyKey, Set<PropertyKey>>()
    for (const path of change.paths) {
        if (path.length < 2 || !allowed.has(path[0])) return null
        let ids = changed.get(path[0])
        if (!ids) { ids = new Set(); changed.set(path[0], ids) }
        ids.add(path[1])
    }
    return changed
}

export function reconcileStoreProjectionRecord<T extends object>(
    store: Store<T>, collectionKey: PropertyKey, itemKey: PropertyKey,
    next: {exists: boolean, value?: unknown},
) {
    const current = toRaw(store.state) as Record<PropertyKey, any>
    const currentCollection = current[collectionKey] as Record<PropertyKey, unknown> | undefined
    const targetCollection = (store.state as Record<PropertyKey, any>)[collectionKey] as Record<PropertyKey, unknown>
    const exists = !!currentCollection && owns(currentCollection, itemKey)
    if (!next.exists) {
        if (!exists) return false
        delete targetCollection[itemKey]
        return true
    }
    if (exists && compareDeepValues(currentCollection![itemKey], next.value)) return false
    defineProjectionValue(targetCollection, itemKey, next.value)
    return true
}
