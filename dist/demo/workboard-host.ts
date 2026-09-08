import {createStore, Store} from '../src/Common/Observe/store'
import {createReplicatedMap} from '../src/Common/Observe/replicated-map'
import {createCommandHost, type CommandCtx} from '../src/Common/command/command-host'
import {
    tWorkboardStatus,
    WorkboardAssignInput,
    WorkboardCreateInput,
    WorkboardItem,
    WorkboardMoveInput,
    WorkboardRemoveResult,
    WorkboardRenameInput,
    WorkboardRevisionInput,
    WorkboardState,
    workboardStatuses,
} from './workboard-contract'

type WorkboardSeed = {
    id: string
    title: string
    status: tWorkboardStatus
    assignee?: string | null
}

type WorkboardHostDeps = {
    initial?: WorkboardSeed[]
    history?: number
    /** Hard cap for a shared/public board; create() rejects above it. */
    maxItems?: number
    now?: () => number
    makeId?: () => string
    /**
     * Failover handover: build authority OVER a READY store (e.g., mirror
     * after promote) — revisions and content are taken as-is, seed is not applied,
     * and live subscriptions of this store's cascade continue working unbroken.
     */
    store?: Store<WorkboardState>
}

function requiredString(value: unknown, label: string, max: number) {
    if (typeof value != 'string') throw new Error(label + ' is required')
    const text = value.trim()
    if (!text) throw new Error(label + ' is required')
    if (text.length > max) throw new Error(label + ` must be at most ${max} characters`)
    return text
}

function copyItem(item: WorkboardItem) {
    return {...item}
}

export function createWorkboardHost(deps: WorkboardHostDeps = {}) {
    const now = deps.now ?? Date.now
    let nextId = 0
    const makeId = deps.makeId ?? function makeWorkboardId() { return 'work-' + (++nextId) }
    const initial: WorkboardState = {}
    let closed = false

    for (const seed of deps.initial ?? []) {
        const id = requiredString(seed.id, 'workboard seed id', 80)
        const timestamp = now()
        initial[id] = {
            id,
            title: requiredString(seed.title, 'workboard seed title', 120),
            status: requireStatus(seed.status),
            assignee: seed.assignee ? requiredString(seed.assignee, 'workboard seed assignee', 80) : null,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            createdBy: 'system',
            updatedBy: 'system',
        }
    }

    function workboardKey(item: WorkboardItem) { return item.id }
    const store = deps.store ?? createStore<WorkboardState>(initial, {drain: 'micro'})
    const replicated = createReplicatedMap<WorkboardItem>({
        keyOf: workboardKey,
        store,
        delivery: 'latest',
        replay: {history: deps.history ?? 512},
    })
    // Accepted store already contains items — id counter must skip over them,
    // or else new leader after promote will issue a taken work-N.
    if (deps.store) {
        for (const id of Object.keys(store.state)) {
            const tail = /^work-(\d+)$/.exec(id)
            if (tail) nextId = Math.max(nextId, Number(tail[1]))
        }
    }
    // ============== business rules ==============
    // Commands carry intent. The replay Store is deliberately read-only on the wire.
    // Idempotency receipts, in-flight dedupe and result cloning live in the LIBRARY
    // command host — this file owns only the domain rules.
    function requireOpen() {
        if (closed) throw new Error('workboard host is closed')
    }

    function requireStatus(value: unknown) {
        if (!workboardStatuses.includes(value as tWorkboardStatus)) throw new Error('workboard status is invalid')
        return value as tWorkboardStatus
    }

    function requireAccount(account: string) {
        return requiredString(account, 'workboard account', 80)
    }

    function requireItem(input: WorkboardRevisionInput) {
        const id = requiredString(input?.id, 'workboard item id', 80)
        const item = store.state[id]
        if (!item) throw new Error('workboard item does not exist')
        if (!Number.isInteger(input.expectedRevision) || input.expectedRevision != item.revision) {
            throw new Error(`workboard revision conflict: expected ${input.expectedRevision}, current ${item.revision}`)
        }
        return item
    }

    function nextUniqueId() {
        for (let attempt = 0; attempt < 1000; attempt++) {
            const id = requiredString(makeId(), 'workboard generated id', 80)
            if (!store.state[id]) return id
        }
        throw new Error('workboard could not allocate a unique id')
    }

    function replaceItem(current: WorkboardItem, account: string, patch: Partial<Pick<WorkboardItem, 'title' | 'status' | 'assignee'>>) {
        const next: WorkboardItem = {
            ...current,
            ...patch,
            revision: current.revision + 1,
            updatedAt: now(),
            updatedBy: account,
        }
        replicated.control.set(next)
        return copyItem(next)
    }

    const commands = createCommandHost({
        receipts: {maxPerAccount: 512},
        commands: {
            create(ctx: CommandCtx, input: WorkboardCreateInput): WorkboardItem {
                const account = requireAccount(ctx.account)
                if (deps.maxItems && Object.keys(store.state).length >= deps.maxItems) {
                    throw new Error('the demo board is full — remove finished items first')
                }
                const timestamp = now()
                const id = nextUniqueId()
                const item: WorkboardItem = {
                    id,
                    title: requiredString(input.title, 'workboard title', 120),
                    status: 'new',
                    assignee: null,
                    revision: 1,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    createdBy: account,
                    updatedBy: account,
                }
                replicated.control.set(item)
                return item
            },
            rename(ctx: CommandCtx, input: WorkboardRenameInput): WorkboardItem {
                const account = requireAccount(ctx.account)
                const item = requireItem(input)
                return replaceItem(item, account, {title: requiredString(input.title, 'workboard title', 120)})
            },
            move(ctx: CommandCtx, input: WorkboardMoveInput): WorkboardItem {
                const account = requireAccount(ctx.account)
                const item = requireItem(input)
                return replaceItem(item, account, {status: requireStatus(input.status)})
            },
            assign(ctx: CommandCtx, input: WorkboardAssignInput): WorkboardItem {
                const account = requireAccount(ctx.account)
                const assignee = input.assignee == null ? null : requiredString(input.assignee, 'workboard assignee', 80)
                const item = requireItem(input)
                return replaceItem(item, account, {assignee})
            },
            remove(ctx: CommandCtx, input: WorkboardRevisionInput): WorkboardRemoveResult {
                requireAccount(ctx.account)
                const item = requireItem(input)
                replicated.control.delete(item.id)
                return {id: item.id, revision: item.revision + 1, deleted: true}
            },
        },
    })
    type tCommand = (typeof commands.names)[number]

    /** One corridor for every entry: requestId travels INSIDE the input on the wire. */
    function run<K extends tCommand>(name: K, account: string, input: any) {
        requireOpen()
        return commands.execute(account, name, requiredString(input?.requestId, 'workboard requestId', 120), input)
    }

    // ============== connection resource ==============
    function connection(accountValue: string) {
        const account = requireAccount(accountValue)
        requireOpen()
        return {
            fragment: {
                state: replicated.api,
                create: (input: WorkboardCreateInput) => run('create', account, input),
                rename: (input: WorkboardRenameInput) => run('rename', account, input),
                move: (input: WorkboardMoveInput) => run('move', account, input),
                assign: (input: WorkboardAssignInput) => run('assign', account, input),
                remove: (input: WorkboardRevisionInput) => run('remove', account, input),
            },
            close() {},
        }
    }

    return {
        control: {
            store,
            create: (account: string, input: WorkboardCreateInput) => run('create', account, input),
            rename: (account: string, input: WorkboardRenameInput) => run('rename', account, input),
            move: (account: string, input: WorkboardMoveInput) => run('move', account, input),
            assign: (account: string, input: WorkboardAssignInput) => run('assign', account, input),
            remove: (account: string, input: WorkboardRevisionInput) => run('remove', account, input),
        },
        /** Trusted hop entry (library CommandForwardFragment shape): (account, requestId, input). */
        forward: commands.forwardFragment(),
        connection,
        close() {
            if (closed) return
            closed = true
            replicated.control.close()
            commands.close()
        },
    }
}

export type WorkboardHost = ReturnType<typeof createWorkboardHost>
