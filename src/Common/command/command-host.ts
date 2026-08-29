// =====================================================================
// Command host — idempotent commands with receipts, forwardable across nodes
// =====================================================================
// The write half of the scaling story: reads replicate freely (Store/replay),
// writes CONVERGE on one authority. This layer makes that corridor a library
// surface instead of per-project wiring:
//   - a command executes AT MOST ONCE per (account, requestId): a duplicate —
//     including one arriving through another node — answers with the first
//     result (the receipt), so any client may safely retry after a reconnect;
//   - forwardCommands gives a mirror node the SAME per-account fragment shape
//     the authority serves, so clients cannot tell the nodes apart.
// Extracted from the proven pattern of the Conversation/AI hosts and the demo
// workboard; those hosts keep their own receipts (they persist them atomically
// with their events) — new hosts should start from this primitive instead.
//
// Trust note (stage 2 will harden this): forwardFragment() is a TRUSTED entry —
// the caller asserts the end client's account. Give it only to links whose
// transport the application has authenticated (service token, resolveAuth).

import {clone} from '../core/common'

// ============================================================
// public contract
// ============================================================

export type CommandCtx = {
    account: string
    requestId: string
    command: string
}

export type tCommandMap = Record<string, (ctx: CommandCtx, input: any) => unknown>

/** Per-account wire fragment: account is bound by the connection, requestId is explicit. */
export type CommandFragment<Cmds extends tCommandMap> = {
    [K in keyof Cmds]: (requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>
}

/** Trusted hop fragment: the forwarding node asserts the END client's account. */
export type CommandForwardFragment<Cmds extends tCommandMap> = {
    [K in keyof Cmds]: (account: string, requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>
}

export type CommandHostDeps<Cmds extends tCommandMap> = {
    commands: Cmds
    /** New executions per account per rolling minute; receipt answers are free. Absent = unlimited. */
    limits?: {perMinute?: number}
    /** How long / how many receipts keep answering duplicates. Errors are never remembered. */
    receipts?: {keepMs?: number, maxPerAccount?: number}
    now?: () => number
}

export const COMMAND_RECEIPT_KEEP_MS = 10 * 60_000
export const COMMAND_RECEIPTS_PER_ACCOUNT = 1024

function requiredName(value: unknown, label: string, max = 200) {
    if (typeof value != 'string' || value.length == 0 || value.length > max) {
        throw new Error(`command host: ${label} must be a non-empty string up to ${max} chars`)
    }
    return value
}

// ============================================================
// host: the single point of order
// ============================================================

export function createCommandHost<Cmds extends tCommandMap>(deps: CommandHostDeps<Cmds>) {
    const {commands, now = Date.now} = deps
    const keepMs = deps.receipts?.keepMs ?? COMMAND_RECEIPT_KEEP_MS
    const maxPerAccount = deps.receipts?.maxPerAccount ?? COMMAND_RECEIPTS_PER_ACCOUNT
    const perMinute = deps.limits?.perMinute ?? 0

    type Receipt = {command: string, ts: number, result?: unknown, pending?: Promise<unknown>}
    // Map preserves insertion order — eviction below relies on it (oldest first).
    const accounts = new Map<string, Map<string, Receipt>>()
    const budgets = new Map<string, {count: number, resetAt: number}>()
    let executions = 0
    let duplicates = 0
    let closed = false

    function accountReceipts(account: string) {
        let receipts = accounts.get(account)
        if (!receipts) {
            receipts = new Map()
            accounts.set(account, receipts)
        }
        return receipts
    }

    function sweep(receipts: Map<string, Receipt>) {
        const deadline = now() - keepMs
        for (const [requestId, receipt] of receipts) {
            if (receipt.pending) continue
            if (receipt.ts > deadline && receipts.size <= maxPerAccount) break
            receipts.delete(requestId)
        }
    }

    function spendBudget(account: string) {
        if (perMinute <= 0) return
        const moment = now()
        const budget = budgets.get(account)
        if (!budget || budget.resetAt <= moment) budgets.set(account, {count: 1, resetAt: moment + 60_000})
        else if (++budget.count > perMinute) throw new Error('command rate limit exceeded — retry later')
    }

    async function execute<K extends keyof Cmds & string>(
        account: string, command: K, requestId: string, input: Parameters<Cmds[K]>[1],
    ): Promise<Awaited<ReturnType<Cmds[K]>>> {
        if (closed) throw new Error('command host is closed')
        requiredName(account, 'account')
        requiredName(requestId, 'requestId')
        const run = commands[requiredName(command, 'command') as K]
        if (typeof run != 'function') throw new Error(`unknown command: ${command}`)

        const receipts = accountReceipts(account)
        const previous = receipts.get(requestId)
        if (previous) {
            if (previous.command != command) {
                throw new Error(`requestId was already used for another command: ${previous.command}`)
            }
            duplicates++
            if (previous.pending) return previous.pending as Promise<Awaited<ReturnType<Cmds[K]>>>
            // a receipt answers with a COPY: the caller may mutate its result freely
            return clone(previous.result) as Awaited<ReturnType<Cmds[K]>>
        }

        spendBudget(account)
        executions++
        const receipt: Receipt = {command, ts: now()}
        const pending = (async function runCommandOnce() {
            const result = await run({account, requestId, command}, input)
            receipt.result = clone(result)
            receipt.pending = undefined
            receipt.ts = now()
            return result
        })()
        receipt.pending = pending
        receipts.set(requestId, receipt)
        sweep(receipts)
        try {
            return await pending as Awaited<ReturnType<Cmds[K]>>
        } catch (error) {
            // an error commits nothing: the SAME requestId may honestly retry
            if (receipts.get(requestId) == receipt) receipts.delete(requestId)
            throw error
        }
    }

    /** Per-connection facade: the connection owner binds the authenticated account once. */
    function fragment(account: string) {
        requiredName(account, 'account')
        const bound = {} as CommandFragment<Cmds>
        for (const name of Object.keys(commands) as (keyof Cmds & string)[]) {
            bound[name] = function boundCommand(requestId: string, input: any) {
                return execute(account, name, requestId, input)
            } as CommandFragment<Cmds>[typeof name]
        }
        return bound
    }

    /** Trusted hop facade for authenticated mirror links; see the trust note above. */
    function forwardFragment() {
        const trusted = {} as CommandForwardFragment<Cmds>
        for (const name of Object.keys(commands) as (keyof Cmds & string)[]) {
            trusted[name] = function forwardedCommand(account: string, requestId: string, input: any) {
                return execute(account, name, requestId, input)
            } as CommandForwardFragment<Cmds>[typeof name]
        }
        return trusted
    }

    function stats() {
        let receipts = 0
        for (const perAccount of accounts.values()) receipts += perAccount.size
        return {accounts: accounts.size, receipts, executions, duplicates}
    }

    return {
        execute,
        fragment,
        forwardFragment,
        names: Object.keys(commands) as (keyof Cmds & string)[],
        stats,
        close() {
            closed = true
            accounts.clear()
            budgets.clear()
        },
    }
}
export type CommandHost<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof createCommandHost<Cmds>>

// ============================================================
// mirror side: the same fragment shape over a trusted upstream hop
// ============================================================

export type ForwardCommandsDeps<Cmds extends tCommandMap> = {
    /** Trusted upstream entry — the authority's forwardFragment(), usually an RPC proxy. */
    upstream: CommandForwardFragment<Cmds>
    /** Command names to expose; an RPC proxy cannot be enumerated, so they are explicit. */
    names: readonly (keyof Cmds & string)[]
}

/** A mirror's per-account command fragment: byte-shape-identical to the authority's. */
export function forwardCommands<Cmds extends tCommandMap>(deps: ForwardCommandsDeps<Cmds>) {
    function fragment(account: string) {
        requiredName(account, 'account')
        const bound = {} as CommandFragment<Cmds>
        for (const name of deps.names) {
            bound[name] = function forwardedToAuthority(requestId: string, input: any) {
                return Promise.resolve(deps.upstream[name](account, requestId, input))
            } as CommandFragment<Cmds>[typeof name]
        }
        return bound
    }
    return {fragment, names: deps.names}
}
export type ForwardedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof forwardCommands<Cmds>>
