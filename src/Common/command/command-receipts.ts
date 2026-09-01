// =====================================================================
// Command receipts line — the at-most-once memory as a replicated fact
// =====================================================================
// A command host remembers (account, requestId) → result so a duplicate answers
// the first result instead of running twice. Kept only in the host's memory,
// that guarantee dies with the process: after a failover or restart the same
// requestId executes again. This makes committed receipts DATA in the
// `receipts` section of a Store served as a Store Replay line: standalone the
// factory owns that store and its line; embedded (deps.store) it is a facet
// over a larger control store (the scale authority's), so receipts travel in
// the SAME line as the roster and the deny list and a successor re-owns all
// three in one instant. The command host sees only CommandReceiptLine.
//
// Boundary, stated once: a receipt is published when the command COMMITS.
// A command in flight at the moment its authority dies has no receipt anywhere
// and may execute again on the successor — the same window every non-
// transactional system has between "did the work" and "recorded the work".

import {createStore, type Store} from '../Observe/store'
import {exposeStoreReplay, type StoreReplayOpts, type StoreReplayRemote} from '../Observe/store-replay'

// ============================================================
// public contract
// ============================================================

export type CommandReceiptRecord = {
    account: string
    requestId: string
    command: string
    /** Commit time on the host clock. */
    ts: number
    result: unknown
}

/** The section shape receipts live in; a control store carries it beside other sections. */
export type CommandReceiptsState = {receipts: Record<string, CommandReceiptRecord>}

/** One key per (account, requestId); the separator cannot appear in either (JSON-safe, not a name char). */
export function commandReceiptKey(account: string, requestId: string) {
    return account + '' + requestId
}

/** The slice a command host depends on; any keyed line of records satisfies it. */
export type CommandReceiptLine = {
    set(record: CommandReceiptRecord): void
    delete(key: string): void
    snapshot(): Record<string, CommandReceiptRecord | undefined>
}

export type CommandReceiptsDeps<S extends CommandReceiptsState = CommandReceiptsState> = {
    /** Embed: receipts become the `receipts` section of THIS store (the caller serves the line). */
    store?: Store<S>
    /** Seed values (standalone only) — e.g. the snapshot a standby followed until it was promoted. */
    initial?: Iterable<CommandReceiptRecord>
    replay?: Pick<StoreReplayOpts, 'history' | 'keepMs' | 'describe'>
}

/** The wire side a standby follows — a Store Replay line whose state carries {receipts}. */
export type CommandReceiptsRemote = StoreReplayRemote

export function createCommandReceipts<S extends CommandReceiptsState = CommandReceiptsState>(deps: CommandReceiptsDeps<S> = {}) {
    const owned = !deps.store
    // the section facet only ever touches .receipts; the wider control store stays the caller's
    const store: Store<CommandReceiptsState> = (deps.store as Store<CommandReceiptsState> | undefined) ?? createStore<CommandReceiptsState>({receipts: {}})
    const exposed = owned ? exposeStoreReplay(store, {
        ...deps.replay,
        describe: {...deps.replay?.describe, commandReceipts: {version: 2}},
    }) : null

    function set(record: CommandReceiptRecord) {
        store.state.receipts[commandReceiptKey(record.account, record.requestId)] = record
    }
    function deleteKey(key: string) {
        if (store.state.receipts[key]) delete store.state.receipts[key]
    }
    function get(key: string) {
        return store.state.receipts[key]
    }
    function snapshot() {
        return store.snapshot().receipts
    }
    function close() {
        exposed?.close()
    }

    if (owned && deps.initial) for (const record of deps.initial) set(record)

    const control: CommandReceiptLine & {get: typeof get, flush: () => void, close: () => void} = {
        set, delete: deleteKey, snapshot, get,
        flush() { exposed?.flushPending() },
        close,
    }
    return {
        /** Store Replay line over {receipts} — standalone only; embedded receipts ride the caller's line. */
        api: (exposed?.api.replay ?? null) as StoreReplayRemote | null,
        control,
        /** The store the receipts live in (the caller's, when embedded). */
        store,
        close,
    }
}
export type CommandReceipts = ReturnType<typeof createCommandReceipts>
