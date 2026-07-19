import {createStore, Store} from '../src/Common/Observe/store'
import {exposeStoreReplay} from '../src/Common/Observe/store-replay'
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
     * Failover-передача: строить авторитет НАД ГОТОВЫМ store (например, зеркальным
     * после promote) — ревизии и содержимое принимаются как есть, seed не применяется,
     * а живые подписки каскада этого store продолжают работать без разрыва.
     */
    store?: Store<WorkboardState>
}

type tCommand = 'create' | 'rename' | 'move' | 'assign' | 'remove'
type tCommandResult = WorkboardItem | WorkboardRemoveResult
type Receipt = {command: tCommand, result: tCommandResult}

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

function copyResult(result: tCommandResult) {
    return {...result}
}

export function createWorkboardHost(deps: WorkboardHostDeps = {}) {
    const now = deps.now ?? Date.now
    let nextId = 0
    const makeId = deps.makeId ?? function makeWorkboardId() { return 'work-' + (++nextId) }
    const initial: WorkboardState = {}
    const receipts = new Map<string, Receipt>()
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

    const store = deps.store ?? createStore<WorkboardState>(initial, {drain: 'micro'})
    // Принятый store уже содержит item'ы — счётчик id обязан перепрыгнуть их,
    // иначе новый лидер после promote выдаст занятый work-N.
    if (deps.store) {
        for (const id of Object.keys(store.state)) {
            const tail = /^work-(\d+)$/.exec(id)
            if (tail) nextId = Math.max(nextId, Number(tail[1]))
        }
    }
    const exposed = exposeStoreReplay(store, {history: deps.history ?? 512})

    // ============== business rules ==============
    // Commands carry intent. The replay Store is deliberately read-only on the wire.
    function requireOpen() {
        if (closed) throw new Error('workboard host is closed')
    }

    function requireStatus(value: unknown) {
        if (!workboardStatuses.includes(value as tWorkboardStatus)) throw new Error('workboard status is invalid')
        return value as tWorkboardStatus
    }

    function requireRequest(input: {requestId: string}) {
        return requiredString(input?.requestId, 'workboard requestId', 120)
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

    function receiptKey(account: string, requestId: string) {
        return account + '\u0000' + requestId
    }

    function previousResult(account: string, requestId: string, command: tCommand) {
        const previous = receipts.get(receiptKey(account, requestId))
        if (!previous) return undefined
        if (previous.command != command) throw new Error('workboard requestId was already used for another command')
        return copyResult(previous.result)
    }

    function remember(account: string, requestId: string, command: tCommand, result: tCommandResult) {
        receipts.set(receiptKey(account, requestId), {command, result: copyResult(result)})
        // Idempotency receipts are a retry guard, not history — bound them so a
        // long-running public stand stays memory-flat (Map keeps insertion order).
        if (receipts.size > 2000) {
            const oldest = receipts.keys().next().value
            if (oldest != null) receipts.delete(oldest)
        }
        return copyResult(result)
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
        store.state[current.id] = next
        return copyItem(next)
    }

    function create(accountValue: string, input: WorkboardCreateInput) {
        requireOpen()
        const account = requireAccount(accountValue)
        const requestId = requireRequest(input)
        const previous = previousResult(account, requestId, 'create')
        if (previous) return previous as WorkboardItem
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
        store.state[id] = item
        return remember(account, requestId, 'create', item) as WorkboardItem
    }

    function rename(accountValue: string, input: WorkboardRenameInput) {
        requireOpen()
        const account = requireAccount(accountValue)
        const requestId = requireRequest(input)
        const previous = previousResult(account, requestId, 'rename')
        if (previous) return previous as WorkboardItem
        const item = requireItem(input)
        const result = replaceItem(item, account, {title: requiredString(input.title, 'workboard title', 120)})
        return remember(account, requestId, 'rename', result) as WorkboardItem
    }

    function move(accountValue: string, input: WorkboardMoveInput) {
        requireOpen()
        const account = requireAccount(accountValue)
        const requestId = requireRequest(input)
        const previous = previousResult(account, requestId, 'move')
        if (previous) return previous as WorkboardItem
        const item = requireItem(input)
        const result = replaceItem(item, account, {status: requireStatus(input.status)})
        return remember(account, requestId, 'move', result) as WorkboardItem
    }

    function assign(accountValue: string, input: WorkboardAssignInput) {
        requireOpen()
        const account = requireAccount(accountValue)
        const requestId = requireRequest(input)
        const previous = previousResult(account, requestId, 'assign')
        if (previous) return previous as WorkboardItem
        const item = requireItem(input)
        const assignee = input.assignee == null ? null : requiredString(input.assignee, 'workboard assignee', 80)
        const result = replaceItem(item, account, {assignee})
        return remember(account, requestId, 'assign', result) as WorkboardItem
    }

    function remove(accountValue: string, input: WorkboardRevisionInput) {
        requireOpen()
        const account = requireAccount(accountValue)
        const requestId = requireRequest(input)
        const previous = previousResult(account, requestId, 'remove')
        if (previous) return previous as WorkboardRemoveResult
        const item = requireItem(input)
        delete store.state[item.id]
        const result: WorkboardRemoveResult = {id: item.id, revision: item.revision + 1, deleted: true}
        return remember(account, requestId, 'remove', result) as WorkboardRemoveResult
    }

    // ============== connection resource ==============
    function connection(accountValue: string) {
        const account = requireAccount(accountValue)
        requireOpen()
        return {
            fragment: {
                state: exposed.api.replay,
                create: (input: WorkboardCreateInput) => create(account, input),
                rename: (input: WorkboardRenameInput) => rename(account, input),
                move: (input: WorkboardMoveInput) => move(account, input),
                assign: (input: WorkboardAssignInput) => assign(account, input),
                remove: (input: WorkboardRevisionInput) => remove(account, input),
            },
            close() {},
        }
    }

    return {
        control: {store, create, rename, move, assign, remove},
        connection,
        close() {
            if (closed) return
            closed = true
            exposed.close()
            receipts.clear()
        },
    }
}

export type WorkboardHost = ReturnType<typeof createWorkboardHost>
