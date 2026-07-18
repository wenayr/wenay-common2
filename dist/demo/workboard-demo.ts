import {WorkboardClient} from './workboard-client'
import {tWorkboardStatus, WorkboardItem} from './workboard-contract'

type WorkboardDemoDeps = {
    client: WorkboardClient
    self: string
    element: (id: string) => HTMLElement
    participantName: (account: string) => string
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

export function setupWorkboardDemo(deps: WorkboardDemoDeps) {
    const {client, self, element, participantName, log} = deps
    const form = element('workboardCreateForm') as HTMLFormElement
    const titleInput = element('workboardTitle') as HTMLInputElement
    const createButton = element('workboardCreate') as HTMLButtonElement
    const filter = element('workboardFilter') as HTMLSelectElement
    const columns = element('workboardColumns')
    const connection = element('workboardConnection')
    const meta = element('workboardMeta')
    const counts = element('workboardCounts')
    const message = element('workboardMessage')
    let requestCounter = 0
    let lastChanged = ''

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

    function renderStatus() {
        const state = client.status()
        connection.textContent = state.connection
        connection.dataset.state = state.connection
        const pending = state.pending ? ` · ${state.pending} pending` : ''
        meta.textContent = `replay seq ${state.seq}${pending}`
        createButton.disabled = state.connection == 'stale' || state.pending > 0
        if (state.lastError && !message.textContent) showMessage(state.lastError, 'error')
    }

    function visible(item: WorkboardItem) {
        if (filter.value == 'mine') return item.assignee == self
        if (filter.value == 'unassigned') return item.assignee == null
        return true
    }

    async function runItemCommand(card: HTMLElement, action: () => Promise<any>, success: string) {
        card.dataset.busy = 'true'
        for (const control of Array.from(card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input'))) control.disabled = true
        showMessage('Saving authoritative change…')
        try {
            await action()
            showMessage(success, 'success')
        } catch (error) {
            const text = errorText(error)
            showMessage(text, 'error')
            log('workboard command rejected: ' + text)
        } finally {
            renderBoard()
            renderStatus()
        }
    }

    function renderItem(item: WorkboardItem) {
        const card = document.createElement('article')
        card.className = 'workItem'
        card.dataset.workItemId = item.id
        card.dataset.changed = String(item.id == lastChanged)

        const titleForm = document.createElement('form')
        titleForm.className = 'workItemTitle'
        const title = document.createElement('input')
        title.value = item.title
        title.maxLength = 120
        title.setAttribute('aria-label', `Title for ${item.id}`)
        const save = button('Save', 'compact secondary')
        save.disabled = true
        title.addEventListener('input', function updateRenameState() {
            save.disabled = !title.value.trim() || title.value.trim() == item.title
        })
        titleForm.addEventListener('submit', function renameWorkItem(event) {
            event.preventDefault()
            void runItemCommand(card, () => client.rename({
                requestId: requestId('rename'), id: item.id, title: title.value, expectedRevision: item.revision,
            }), 'Title updated')
        })
        titleForm.append(title, save)

        const details = document.createElement('div')
        details.className = 'workItemMeta'
        details.textContent = `${accountLabel(item.assignee)} · r${item.revision} · ${accountLabel(item.updatedBy)}`

        const actions = document.createElement('div')
        actions.className = 'workItemActions'
        const statusIndex = client.statuses.indexOf(item.status)
        if (statusIndex > 0) {
            const previous = client.statuses[statusIndex - 1]
            const moveBack = button('← ' + statusLabels[previous], 'compact secondary')
            moveBack.addEventListener('click', function moveWorkItemBack() {
                void runItemCommand(card, () => client.move({
                    requestId: requestId('move'), id: item.id, status: previous, expectedRevision: item.revision,
                }), `Moved to ${statusLabels[previous]}`)
            })
            actions.append(moveBack)
        }
        if (statusIndex < client.statuses.length - 1) {
            const next = client.statuses[statusIndex + 1]
            const moveNext = button(statusLabels[next] + ' →', 'compact primary')
            moveNext.addEventListener('click', function moveWorkItemNext() {
                void runItemCommand(card, () => client.move({
                    requestId: requestId('move'), id: item.id, status: next, expectedRevision: item.revision,
                }), `Moved to ${statusLabels[next]}`)
            })
            actions.append(moveNext)
        }
        const assign = button(item.assignee == self ? 'Unassign' : 'Assign to me', 'compact secondary')
        assign.addEventListener('click', function assignWorkItem() {
            void runItemCommand(card, () => client.assign({
                requestId: requestId('assign'), id: item.id, assignee: item.assignee == self ? null : self,
                expectedRevision: item.revision,
            }), item.assignee == self ? 'Item unassigned' : 'Item assigned to you')
        })
        const remove = button('Delete', 'compact danger')
        remove.addEventListener('click', function removeWorkItem() {
            void runItemCommand(card, () => client.remove({
                requestId: requestId('remove'), id: item.id, expectedRevision: item.revision,
            }), 'Item deleted')
        })
        actions.append(assign, remove)
        card.append(titleForm, details, actions)
        return card
    }

    function renderBoard() {
        const currentCounts = client.counts()
        counts.textContent = `${currentCounts.new} new · ${currentCounts.active} active · ${currentCounts.done} done`
        columns.replaceChildren()
        for (const status of client.statuses) {
            const section = document.createElement('section')
            section.className = 'workColumn'
            section.dataset.status = status
            const heading = document.createElement('header')
            const label = document.createElement('strong')
            label.textContent = statusLabels[status]
            const count = document.createElement('span')
            const items = client.items(status).filter(visible)
            count.textContent = String(items.length)
            heading.append(label, count)
            const content = document.createElement('div')
            content.className = 'workColumnItems'
            for (const item of items) content.append(renderItem(item))
            if (!items.length) {
                const empty = document.createElement('p')
                empty.className = 'emptyState'
                empty.textContent = 'No matching items'
                content.append(empty)
            }
            section.append(heading, content)
            columns.append(section)
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
            const text = errorText(error)
            showMessage(text, 'error')
            log('workboard create rejected: ' + text)
        } finally {
            renderStatus()
        }
    })
    filter.addEventListener('change', renderBoard)

    // Keyframes and live replay both expand to the same per-item callback.
    const offItems = client.store.each().on(function renderChangedWorkItem(key) {
        lastChanged = key
        renderBoard()
        renderStatus()
    })
    const offStatus = client.statusChanges.on(function renderWorkboardStatus() { renderStatus() })
    renderBoard()
    renderStatus()

    return {
        close() {
            offItems()
            offStatus()
        },
    }
}
