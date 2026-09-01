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
import {createRateWindow} from '../funcTimeWait'
import {bindCommandNames} from './command-fragment'
import {commandReceiptKey, type CommandReceiptLine} from './command-receipts'

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
    /** How long / how many receipts keep answering duplicates. Errors are never remembered.
     *  maxTotal bounds the WHOLE host across accounts, so a long-running public stand stays
     *  memory-flat no matter how many one-visit accounts pass through. */
    receipts?: {
        keepMs?: number, maxPerAccount?: number, maxTotal?: number,
        /** Replicated receipts line: committed receipts are published here and the
         *  index is rebuilt from it — at-most-once survives the process. See adopt(). */
        line?: CommandReceiptLine
    }
    now?: () => number
}

export const COMMAND_RECEIPT_KEEP_MS = 10 * 60_000
export const COMMAND_RECEIPTS_PER_ACCOUNT = 1024
export const COMMAND_RECEIPTS_TOTAL = 8192

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
    const maxTotal = deps.receipts?.maxTotal ?? COMMAND_RECEIPTS_TOTAL
    const perMinute = deps.limits?.perMinute ?? 0
    // the project's sliding-window limiter with the host's clock: genuinely
    // rolling, so a burst at the window boundary cannot double the limit
    const rate = perMinute > 0 ? createRateWindow({now}) : null

    type Receipt = {command: string, ts: number, result?: unknown, pending?: Promise<unknown>}
    // Both Maps preserve insertion order. Inner: receipts oldest-first. Outer:
    // accountReceipts re-inserts on every use, so the FIRST account is always
    // the longest-idle one — draining and global eviction both start there.
    const accounts = new Map<string, Map<string, Receipt>>()
    // the replicated projection of COMMITTED receipts; the Maps stay the index
    let line: CommandReceiptLine | null = null
    let totalReceipts = 0
    let executions = 0
    let duplicates = 0
    let closed = false

    function accountReceipts(account: string) {
        let receipts = accounts.get(account)
        if (!receipts) receipts = new Map()
        else accounts.delete(account)
        accounts.set(account, receipts)
        return receipts
    }

    function dropReceipt(account: string, receipts: Map<string, Receipt>, requestId: string) {
        const receipt = receipts.get(requestId)
        if (!receipt) return
        receipts.delete(requestId)
        totalReceipts--
        // a pending receipt was never published — only committed ones leave the line
        if (line && !receipt.pending) line.delete(commandReceiptKey(account, requestId))
    }

    function dropAccount(account: string, receipts: Map<string, Receipt>) {
        if (line) {
            for (const [requestId, receipt] of receipts) {
                if (!receipt.pending) line.delete(commandReceiptKey(account, requestId))
            }
        }
        totalReceipts -= receipts.size
        accounts.delete(account)
        // receipts may expire before the minute does (keepMs < 60s): forgetting the
        // window then would hand a rate-limited account a fresh budget early
        if (rate && rate.sumWeight(account, 60_000) == 0) rate.drop(account)
    }

    function sweep(account: string, receipts: Map<string, Receipt>) {
        const deadline = now() - keepMs
        for (const [requestId, receipt] of receipts) {
            if (receipt.pending) continue
            if (receipt.ts > deadline && receipts.size <= maxPerAccount) break
            dropReceipt(account, receipts, requestId)
        }
    }

    /** Fully expired (or empty) account — safe to forget wholesale. */
    function accountExpired(receipts: Map<string, Receipt>, deadline: number) {
        for (const receipt of receipts.values()) {
            if (receipt.pending || receipt.ts > deadline) return false
        }
        return true
    }

    /** Called once per execution: drains departed accounts and holds the global bound.
     *  The recency order of `accounts` makes both amortized-cheap — each pass starts
     *  at the longest-idle account and stops at the first live one. */
    function compact() {
        const deadline = now() - keepMs
        for (const [account, receipts] of accounts) {
            if (!accountExpired(receipts, deadline)) break
            dropAccount(account, receipts)
        }
        // pending receipts are unevictable, so the loop is bounded instead of while(true)
        for (let guard = accounts.size + totalReceipts; totalReceipts > maxTotal && guard > 0; guard--) {
            const first = accounts.entries().next()
            if (first.done) break
            const [account, receipts] = first.value
            let evicted = false
            for (const [requestId, receipt] of receipts) {
                if (receipt.pending) continue
                dropReceipt(account, receipts, requestId)
                evicted = true
                break
            }
            if (receipts.size == 0) dropAccount(account, receipts)
            else if (!evicted) {
                // only in-flight receipts left: rotate it back and try the next account
                accounts.delete(account)
                accounts.set(account, receipts)
            }
        }
    }

    function spendBudget(account: string) {
        if (!rate) return
        if (rate.sumWeight(account, 60_000) >= perMinute) {
            throw new Error('command rate limit exceeded — retry later')
        }
        rate.add({type: account, weight: 1})
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
            if (previous.pending) {
                // the in-flight answer is ALSO a copy: the original caller receives
                // the raw result, and sharing that reference would break the
                // receipt guarantee below exactly when two callers race
                return (previous.pending as Promise<unknown>).then(function cloneInFlightAnswer() {
                    return clone(previous.result)
                }) as Promise<Awaited<ReturnType<Cmds[K]>>>
            }
            // a receipt answers with a COPY: the caller may mutate its result freely
            return clone(previous.result) as Awaited<ReturnType<Cmds[K]>>
        }

        try {
            spendBudget(account)
        } catch (error) {
            // a rejected newcomer must not leave an empty receipts Map behind
            if (receipts.size == 0) accounts.delete(account)
            throw error
        }
        executions++
        const receipt: Receipt = {command, ts: now()}
        const pending = (async function runCommandOnce() {
            const result = await run({account, requestId, command}, input)
            receipt.result = clone(result)
            receipt.pending = undefined
            receipt.ts = now()
            // the commit IS the publication: a successor answering from the line
            // holds exactly what this host would have answered
            if (line && receipts.get(requestId) == receipt) {
                line.set({account, requestId, command, ts: receipt.ts, result: clone(receipt.result)})
            }
            return result
        })()
        receipt.pending = pending
        receipts.set(requestId, receipt)
        totalReceipts++
        sweep(account, receipts)
        compact()
        try {
            return await pending as Awaited<ReturnType<Cmds[K]>>
        } catch (error) {
            // an error commits nothing: the SAME requestId may honestly retry
            if (receipts.get(requestId) == receipt) dropReceipt(account, receipts, requestId)
            throw error
        }
    }

    /** Make `next` the receipt memory: the index is rebuilt from its snapshot (bounds
     *  enforced on the line too) and every later commit/drop is published there. null
     *  detaches — the in-memory index keeps answering, nothing is published. Called by
     *  an authority on promotion with the line it seeded from the followed snapshot. */
    function adopt(next: CommandReceiptLine | null) {
        line = null
        accounts.clear()
        totalReceipts = 0
        if (!next) return
        const records = Object.values(next.snapshot()).filter(Boolean) as NonNullable<ReturnType<CommandReceiptLine['snapshot']>[string]>[]
        // oldest first, so per-account and account recency orders match a live history
        records.sort(function byCommitTime(a, b) { return a.ts - b.ts })
        for (const record of records) {
            const receipts = accountReceipts(record.account)
            receipts.set(record.requestId, {command: record.command, ts: record.ts, result: record.result})
            totalReceipts++
        }
        line = next
        for (const [account, receipts] of [...accounts]) sweep(account, receipts)
        compact()
    }
    if (deps.receipts?.line) adopt(deps.receipts.line)

    const names = Object.keys(commands) as (keyof Cmds & string)[]

    /** Per-connection facade: the connection owner binds the authenticated account once. */
    function fragment(account: string) {
        requiredName(account, 'account')
        return bindCommandNames<CommandFragment<Cmds>>(names, function bindAccountCommand(name) {
            return function boundCommand(requestId: string, input: any) {
                return execute(account, name as keyof Cmds & string, requestId, input)
            }
        })
    }

    /** Trusted hop facade for authenticated mirror links; see the trust note above. */
    function forwardFragment() {
        return bindCommandNames<CommandForwardFragment<Cmds>>(names, function bindTrustedCommand(name) {
            return function forwardedCommand(account: string, requestId: string, input: any) {
                return execute(account, name as keyof Cmds & string, requestId, input)
            }
        })
    }

    function stats() {
        return {accounts: accounts.size, receipts: totalReceipts, executions, duplicates}
    }

    return {
        execute,
        fragment,
        forwardFragment,
        names,
        stats,
        adopt,
        close() {
            closed = true
            for (const account of accounts.keys()) rate?.drop(account)
            accounts.clear()
            totalReceipts = 0
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
        return bindCommandNames<CommandFragment<Cmds>>(deps.names, function bindMirrorCommand(name) {
            return function forwardedToAuthority(requestId: string, input: any) {
                return Promise.resolve(deps.upstream[name as keyof Cmds & string](account, requestId, input))
            }
        })
    }
    return {fragment, names: deps.names}
}
export type ForwardedCommands<Cmds extends tCommandMap = tCommandMap> = ReturnType<typeof forwardCommands<Cmds>>
