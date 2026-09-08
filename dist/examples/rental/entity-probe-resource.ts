import {createListenCore} from 'wenay-common2/listen'

type EntityValue = {id: string, value: number}

export function createEntityProbe(deps: {mode: 'shared' | 'facades', count: number}) {
    if (!Number.isSafeInteger(deps.count) || deps.count < 0) throw new Error('count must be a nonnegative integer')
    if (deps.mode != 'shared' && deps.mode != 'facades') throw new Error('unknown probe mode')
    const rows = new Map<string, {owner: string, value: number}>()
    const streams = new Map<string, ReturnType<typeof createListenCore<[EntityValue]>>>()
    const facades = new Map<string, ReturnType<typeof createEntityFacade>>()
    let closed = false

    // === One resource core for both addressing strategies ===
    function requireRow(id: string, account: string) {
        if (closed) throw new Error('entity probe closed')
        const row = rows.get(id)
        if (!row || row.owner != account) throw new Error('entity forbidden or missing')
        return row
    }

    function read(id: string, account: string) {
        const row = requireRow(id, account)
        return {id, value: row.value}
    }

    function write(id: string, account: string, value: number) {
        const row = requireRow(id, account)
        row.value = value
        streams.get(id)?.emit({id, value})
    }

    function remove(id: string, account: string) {
        requireRow(id, account)
        rows.delete(id)
        facades.delete(id)
        const stream = streams.get(id)
        streams.delete(id)
        stream?.close()
    }

    function on(id: string, account: string, cb: (value: EntityValue) => void) {
        requireRow(id, account)
        let stream = streams.get(id)
        if (!stream) {
            stream = createListenCore<[EntityValue]>()
            streams.set(id, stream)
        }
        const source = stream
        const off = source.on(function deliver(value) { cb({...value}) })
        return function unsubscribe() {
            off()
            if (source.count() == 0 && streams.get(id) == source) {
                streams.delete(id)
                source.close()
            }
        }
    }

    // === Eager entity facades; listeners remain lazy in either mode ===
    function createEntityFacade(id: string) {
        return {
            view: {read: function readEntity(account: string) { return read(id, account) }},
            control: {
                write: function writeEntity(account: string, value: number) { write(id, account, value) },
                remove: function removeEntity(account: string) { remove(id, account) },
            },
            events: {on: function subscribeEntity(account: string, cb: (value: EntityValue) => void) { return on(id, account, cb) }},
        }
    }

    function facadeFor(id: string, account: string) {
        const facade = facades.get(id)
        if (!facade) requireRow(id, account)
        return facade!
    }

    for (let index = 0; index < deps.count; index++) {
        const id = String(index)
        rows.set(id, {owner: 'alice', value: 0})
        if (deps.mode == 'facades') facades.set(id, createEntityFacade(id))
    }

    function counts() {
        let subscriptions = 0
        for (const stream of streams.values()) subscriptions += stream.count()
        return {entities: rows.size, facades: facades.size, streams: streams.size, subscriptions}
    }

    function close() {
        if (closed) return
        closed = true
        rows.clear()
        facades.clear()
        for (const stream of streams.values()) stream.close()
        streams.clear()
    }

    if (deps.mode == 'shared') return {view: {read, counts}, control: {write, remove}, events: {on}, close}
    return {
        view: {read: function readFacade(id: string, account: string) { return facadeFor(id, account).view.read(account) }, counts},
        control: {
            write: function writeFacade(id: string, account: string, value: number) { facadeFor(id, account).control.write(account, value) },
            remove: function removeFacade(id: string, account: string) { facadeFor(id, account).control.remove(account) },
        },
        events: {on: function subscribeFacade(id: string, account: string, cb: (value: EntityValue) => void) {
            return facadeFor(id, account).events.on(account, cb)
        }},
        close,
    }
}

export type EntityProbe = ReturnType<typeof createEntityProbe>
