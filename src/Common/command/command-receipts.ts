// =====================================================================
// Command receipts line — the at-most-once memory as a replicated fact
// =====================================================================
// A command host remembers (account, requestId) → result so a duplicate answers
// the first result instead of running twice. Kept only in the host's memory,
// that guarantee dies with the process: after a failover or restart the same
// requestId executes again. This line makes committed receipts DATA on an
// ordinary latest-delivery replicated map: a standby authority follows it, a
// promoted one seeds its own line from the followed snapshot and the host
// adopts that line — so the receipt space survives the process that built it.
//
// Boundary, stated once: a receipt is published when the command COMMITS.
// A command in flight at the moment its authority dies has no receipt anywhere
// and may execute again on the successor — the same window every non-
// transactional system has between "did the work" and "recorded the work".

import {createReplicatedMap, type ReplicatedMap, type ReplicatedMapRemote} from '../Observe/replicated-map'

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

/** One key per (account, requestId); the separator cannot appear in either (JSON-safe, not a name char). */
export function commandReceiptKey(account: string, requestId: string) {
    return account + '' + requestId
}

export type CommandReceiptsDeps = {
    /** Seed values — usually the snapshot a standby followed until it was promoted. */
    initial?: Iterable<CommandReceiptRecord>
    lineId?: string
    replay?: {history?: number, keepMs?: number, describe?: Record<string, any>}
}

/** The slice of the line a command host depends on; any replicated map of records satisfies it. */
export type CommandReceiptLine = Pick<ReplicatedMap<CommandReceiptRecord>['control'], 'set' | 'delete' | 'snapshot'>

/** The wire side a standby follows — the same remote shape every replicated map serves. */
export type CommandReceiptsRemote = ReplicatedMapRemote<CommandReceiptRecord>

export function createCommandReceipts(deps: CommandReceiptsDeps = {}) {
    const map = createReplicatedMap<CommandReceiptRecord>({
        keyOf(record) { return commandReceiptKey(record.account, record.requestId) },
        delivery: 'latest',
        ...(deps.initial ? {initial: deps.initial} : {}),
        ...(deps.lineId != undefined ? {lineId: deps.lineId} : {}),
        ...(deps.replay ? {replay: deps.replay} : {}),
    })
    return {
        /** Store Replay fragment — serve it to standbys like any replicated map. */
        api: map.api,
        control: map.control satisfies CommandReceiptLine,
    }
}
export type CommandReceipts = ReturnType<typeof createCommandReceipts>
