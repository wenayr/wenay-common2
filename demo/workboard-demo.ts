import {WorkboardClient} from './workboard-client'
import {tWorkboardStatus, WorkboardItem} from './workboard-contract'

type WorkboardDemoDeps = {
    client: WorkboardClient
    self: string
    element: (id: string) => HTMLElement
    participantName: (account: string) => string
    /** Online accounts feeding the assignee picker; self is always offered. */
    participants?: () => string[]
    log: (line: string) => void
}

const statusLabels: Record<tWorkboardStatus, string> = {
    new: 'New',
    active: 'In progress',
    done: 'Done',
}

function errorText(error: unknown) {
    if (typeof (error as any)?.message == 'string') return (error as any).message
    return String(error)
}

function button(label: string, className = '') {
    const result = document.createElement('button')
    result.type = 'button'
    result.textContent = label
    result.className = className
    return result
}

// The board re-renders on every replay tick; a full rebuild would eat the
// caret mid-rename. Cards are keyed by item id and patched in place. Sort
// keys (createdAt, id) are immutable, so a card only ever MOVES between
// columns — never within one — and a focused rename input stays mounted.
export function setupWorkboardDemo(deps: WorkboardDemoDeps) {
    const {client, self, element, participantName, log} = deps
    const form = element('workboardCreateForm') as HTMLFormElement
    const titleInput = element('workboardTitle') as HTMLInputElement
    const createButton = element('workboardCreate') as HTMLButtonElement
    const filter = element('workboardFilter') as HTMLSelectElement
    const columnsBox = element('workboardColumns')
    const connection = element('workboardConnection')
    const meta = element('workboardMeta')
    const counts = element('workboardCounts')
    const message = element('workboardMessage')
    const feed = element('workboardFeed')
    const feedLines: string[] = []
    const cards = new Map<string, Card>()
    const columns = new Map<tWorkboardStatus, {items: HTMLElement, count: HTMLElement, empty: HTMLElement}>()
    let requestCounter = 0

    function requestId(command: string) {
        requestCounter++
        return `${self}-${command}-${Date.now().toString(36)}-${requestCounter}`
    }

    function accountLabel(account: string | null) {
        if (!account) return 'Unassigned'
        if (account == 'system') return 'System'
        return account.startsWith('person-') ? `Participant ${participantName(account)}` : account
    }

    function showMessage(text: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
        message.textContent = text
        message.dataset.tone = tone
    }

    // The board already holds the newer revision by the time a rejection
    // lands — translate the protocol text into a human sentence.
    function friendly(error: unknown) {
        const text = errorText(error)
        return /revision conflict/.test(text)
            ? 'Someone changed this item first — the card has refreshed, try your change again.'
            : text
    }

    function renderStatus() {
        const state = client.status()
        connection.textContent = state.connection
        connection.dataset.state = state.connection
        const pending = state.pending ? ` · ${state.pending} pending` : ''
        meta.textContent = `map ${state.delivery} · replay ${state.replayMode} · seq ${state.seq}${pending}`
        createButton.disabled = state.connection == 'stale' || state.pending > 0
        if (state.lastError && !message.textContent) showMessage(state.lastError, 'error')
    }

    function visible(item: WorkboardItem) {
        if (filter.value == 'mine') return item.assignee == self
        if (filter.value == 'unassigned') return item.assignee == null
        return true
    }

    // ============== columns: built once, cards reconcile into them ==============
    for (const status of client.statuses) {
        const section = document.createElement('section')
        section.className = 'workColumn'
        section.dataset.status = status
        const heading = document.createElement('header')
        const label = document.createElement('strong')
        label.textContent = statusLabels[status]
        const count = document.createElement('span')
        heading.append(label, count)
        const items = document.createElement('div')
        items.className = 'workColumnItems'
        const empty = document.createElement('p')
        empty.className = 'emptyState'
        empty.textContent = 'No matching items'
        section.append(heading, items, empty)
        columnsBox.append(section)
        columns.set(status, {items, count, empty})

        // Whole column is a drop target — same command path as the buttons.
        section.addEventListener('dragover', function allowWorkItemDrop(event) {
            event.preventDefault()
            section.classList.add('dropTarget')
        })
        section.addEventListener('dragleave', function clearWorkItemDrop() {
            section.classList.remove('dropTarget')
        })
        section.addEventListener('drop', function dropWorkItem(event) {
            event.preventDefault()
            section.classList.remove('dropTarget')
            const id = event.dataTransfer?.getData('text/plain')
            const card = id ? cards.get(id) : undefined
            if (!card || card.current().status == status) return
            card.move(status)
        })
    }

    // ============== a card: one closure per item id ==============
    function createCard(initial: WorkboardItem) {
        let current = initial
        const root = document.createElement('article')
        root.className = 'workItem'
        root.draggable = true
        root.dataset.workItemId = current.id
        root.addEventListener('dragstart', function dragWorkItem(event) {
            event.dataTransfer?.setData('text/plain', current.id)
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        })

        const titleForm = document.createElement('form')
        titleForm.className = 'workItemTitle'
        const title = document.createElement('input')
        title.maxLength = 120
        title.value = current.title
        title.setAttribute('aria-label', `Title for ${current.id}`)
        const save = button('Save', 'compact secondary')
        titleForm.append(title, save)
        title.addEventListener('input', function updateRenameState() { renderTitle() })
        titleForm.addEventListener('submit', function renameWorkItem(event) {
            event.preventDefault()
            void run(() => client.rename({
                requestId: requestId('rename'), id: current.id, title: title.value, expectedRevision: current.revision,
            }), 'Title updated')
        })

        const details = document.createElement('div')
        details.className = 'workItemMeta'
        const actions = document.createElement('div')
        actions.className = 'workItemActions'
        const back = button('', 'compact secondary')
        const next = button('', 'compact primary')
        back.addEventListener('click', function moveWorkItemBack() {
            const target = client.statuses[client.statuses.indexOf(current.status) - 1]
            if (target) move(target)
        })
        next.addEventListener('click', function moveWorkItemNext() {
            const target = client.statuses[client.statuses.indexOf(current.status) + 1]
            if (target) move(target)
        })
        const assign = document.createElement('select')
        assign.className = 'assignSelect'
        assign.setAttribute('aria-label', `Assignee for ${current.id}`)
        assign.addEventListener('change', function assignWorkItem() {
            const assignee = assign.value || null
            void run(() => client.assign({
                requestId: requestId('assign'), id: current.id, assignee, expectedRevision: current.revision,
            }), assignee ? `Assigned to ${accountLabel(assignee)}` : 'Item unassigned')
        })
        const remove = button('Delete', 'compact danger')
        remove.addEventListener('click', function removeWorkItem() {
            void run(() => client.remove({
                requestId: requestId('remove'), id: current.id, expectedRevision: current.revision,
            }), 'Item deleted')
        })
        actions.append(back, next, assign, remove)
        root.append(titleForm, details, actions)

        function move(target: tWorkboardStatus) {
            void run(() => client.move({
                requestId: requestId('move'), id: current.id, status: target, expectedRevision: current.revision,
            }), `Moved to ${statusLabels[target]}`, target)
        }

        async function run(action: () => Promise<unknown>, success: string, optimisticStatus?: tWorkboardStatus) {
            root.dataset.busy = 'true'
            // Optimistic presentation only: the card slides to the target column
            // right away; the authoritative replay confirms it or snaps it back.
            if (optimisticStatus) columns.get(optimisticStatus)?.items.append(root)
            showMessage('Saving authoritative change…')
            try {
                await action()
                showMessage(success, 'success')
            } catch (error) {
                showMessage(friendly(error), 'error')
                log('workboard command rejected: ' + errorText(error))
            } finally {
                root.dataset.busy = 'false'
                renderBoard()
                renderStatus()
            }
        }

        function renderTitle() {
            // Never overwrite what the user is typing; sync the rest of the card.
            if (document.activeElement != title) title.value = current.title
            save.disabled = !title.value.trim() || title.value.trim() == current.title
        }

        function renderAssign() {
            if (document.activeElement == assign) return // an open dropdown stays put
            const online = deps.participants?.() ?? []
            const known = Array.from(new Set([self, ...online, ...(current.assignee ? [current.assignee] : [])]))
            assign.replaceChildren(new Option('Unassigned', ''))
            for (const account of known) {
                assign.append(new Option(
                    account == self ? `Me · ${participantName(account)}` : participantName(account),
                    account,
                ))
            }
            assign.value = current.assignee ?? ''
        }

        function update(item: WorkboardItem) {
            current = item
            renderTitle()
            renderAssign()
            details.textContent = `${accountLabel(item.assignee)} · r${item.revision} · by ${accountLabel(item.updatedBy)}`
            const index = client.statuses.indexOf(item.status)
            const backTarget = client.statuses[index - 1]
            const nextTarget = client.statuses[index + 1]
            back.hidden = !backTarget
            next.hidden = !nextTarget
            if (backTarget) back.textContent = '← ' + statusLabels[backTarget]
            if (nextTarget) next.textContent = statusLabels[nextTarget] + ' →'
        }

        update(initial)
        return {root, update, move, current: () => current, highlight: highlightCard}
        function highlightCard() {
            root.dataset.changed = 'true'
            setTimeout(function clearWorkItemHighlight() { root.dataset.changed = 'false' }, 1400)
        }
    }
    type Card = ReturnType<typeof createCard>

    // ============== keyed reconciliation ==============
    function renderBoard() {
        const currentCounts = client.counts()
        counts.textContent = `${currentCounts.new} new · ${currentCounts.active} active · ${currentCounts.done} done`
        const live = new Set<string>()
        const shown = new Set<string>()
        const byStatus = new Map<tWorkboardStatus, WorkboardItem[]>(client.statuses.map(status => [status, []]))
        for (const item of client.items()) {
            live.add(item.id)
            if (visible(item)) byStatus.get(item.status)!.push(item)
        }
        for (const [id, card] of cards) {
            if (!live.has(id)) { card.root.remove(); cards.delete(id) }
        }
        for (const status of client.statuses) {
            const column = columns.get(status)!
            const items = byStatus.get(status)!
            column.count.textContent = String(items.length)
            column.empty.hidden = items.length > 0
            items.forEach(function placeWorkItem(item, index) {
                shown.add(item.id)
                let card = cards.get(item.id)
                if (!card) { card = createCard(item); cards.set(item.id, card) }
                card.update(item)
                const desired = column.items.children[index] ?? null
                if (desired != card.root) column.items.insertBefore(card.root, desired)
            })
        }
        for (const [id, card] of cards) {
            if (!shown.has(id)) card.root.remove() // filtered out, kept for later
        }
    }

    form.addEventListener('submit', async function createWorkItem(event) {
        event.preventDefault()
        const title = titleInput.value.trim()
        if (!title) return
        createButton.disabled = true
        showMessage('Creating item…')
        try {
            await client.create({requestId: requestId('create'), title})
            titleInput.value = ''
            showMessage('Item created and broadcast to every participant', 'success')
        } catch (error) {
            showMessage(friendly(error), 'error')
            log('workboard create rejected: ' + errorText(error))
        } finally {
            renderStatus()
        }
    })
    filter.addEventListener('change', renderBoard)

    // ============== compact activity feed ==============
    // The feed diffs against COPIES: the replay mirror applies per-path deltas
    // into the existing item object (mutation in place), so holding a reference
    // would always compare the new state with itself.
    const lastSeen = new Map<string, WorkboardItem>()

    function renderFeed() {
        feed.hidden = !feedLines.length
        feed.replaceChildren()
        for (const line of feedLines) {
            const row = document.createElement('div')
            row.textContent = line
            feed.append(row)
        }
    }

    function noteActivity(key: string) {
        const next = client.get(key)
        const previous = lastSeen.get(key)
        if (next) lastSeen.set(key, {...next})
        else lastSeen.delete(key)
        // The initial keyframe only seeds the snapshot — no narration for it.
        if (client.status().connection != 'live') return
        let line: string | null = null
        if (next && !previous) line = `${accountLabel(next.updatedBy)} added “${next.title}”`
        else if (!next && previous) line = `“${previous.title}” was removed`
        else if (next && previous) {
            if (next.status != previous.status) line = `${accountLabel(next.updatedBy)} moved “${next.title}” to ${statusLabels[next.status]}`
            else if (next.title != previous.title) line = `${accountLabel(next.updatedBy)} renamed “${previous.title}” to “${next.title}”`
            else if (next.assignee != previous.assignee) line = `${accountLabel(next.updatedBy)} assigned “${next.title}” to ${accountLabel(next.assignee)}`
        }
        if (!line) return
        feedLines.unshift(`${new Date().toLocaleTimeString()} · ${line}`)
        if (feedLines.length > 8) feedLines.pop()
        renderFeed()
    }

    // One physical replay envelope produces one UI render, even when many keys changed.
    const offItems = client.batches.on(function renderWorkboardBatch(change) {
        const changedKeys = new Set(change.operations.map(operation => operation.key))
        for (const key of changedKeys) {
            noteActivity(key)
            cards.get(key)?.highlight()
        }
        renderBoard()
        renderStatus()
    })
    const offStatus = client.statusChanges.on(function renderWorkboardStatus() { renderStatus() })
    renderBoard()
    renderStatus()

    return {
        /** Repaint labels (e.g. a participant renamed) without a board change. */
        render() {
            renderBoard()
            renderStatus()
        },
        close() {
            offItems()
            offStatus()
        },
    }
}
