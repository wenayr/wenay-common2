// =====================================================================
// Service tokens stand — browser half
// =====================================================================
// Four buttons, four scenarios, one verdict list. The scenario logic lives in the DOM-free client
// module (the oracle drives the same one); this file only paints: which layer decided each step,
// who holds a token in this tab's sandbox right now, and what the board says.

import {
    createServiceTokenClient,
    serviceTokenLayers,
    serviceTokenScenarios,
    type ServiceTokenReport,
    type ServiceTokenSnapshot,
    type ServiceTokenVerdict,
    type tServiceTokenScenario,
} from './service-token-client'
import {serviceTokenCredentials, serviceTokenLimits} from './service-token-contract'

type ServiceTokenDemoDeps = {
    element: (id: string) => HTMLElement
    log: (line: string) => void
    /** Same tab identity the participant connection uses — one human, one browser tab. */
    tab: string
}

type tTone = 'good' | 'bad'

function clock(at: number) {
    return new Date(at).toLocaleTimeString()
}

export function setupServiceTokenDemo(deps: ServiceTokenDemoDeps) {
    const {element, log} = deps
    const client = createServiceTokenClient({origin: location.origin, tab: deps.tab})
    const statusBadge = element('stStatus')
    const sandboxLine = element('stSandbox')
    const sandboxNote = element('stSandboxNote')
    const principalLines = {
        board: {who: element('stBoardWho'), token: element('stBoardToken')},
        desk: {who: element('stDeskWho'), token: element('stDeskToken')},
    }
    const notesLine = element('stNotes')
    const notesNote = element('stNotesNote')
    const resultLine = element('stResult')
    const verdictBox = element('stVerdicts')
    const buttons = {
        handshake: element('stHandshake') as HTMLButtonElement,
        issued: element('stIssued') as HTMLButtonElement,
        selfIssued: element('stSelfIssued') as HTMLButtonElement,
        revoke: element('stRevoke') as HTMLButtonElement,
    } satisfies {[K in tServiceTokenScenario]: HTMLButtonElement}
    const resetButton = element('stReset') as HTMLButtonElement
    let busy = false
    let failedLast = false

    // demo credentials come from the contract: the panel and the host cannot drift apart
    element('stCredentials').textContent = 'Demo credentials: '
        + Object.entries(serviceTokenCredentials).map(([account, password]) => account + ' / ' + password).join(' · ')
        + ' — they open only this tab\'s sandbox. Bounds: ' + serviceTokenLimits.maxSandboxes + ' sandboxes, '
        + serviceTokenLimits.callsPerMinute + ' calls/min each, ' + serviceTokenLimits.maxNotes + ' notes per board, closed after '
        + Math.round(serviceTokenLimits.sandboxIdleMs / 60_000) + ' idle min.'

    // ============== cards: the sandbox, both principals, the board ==============

    function renderSnapshot(snapshot: ServiceTokenSnapshot) {
        const {sandbox} = snapshot
        sandboxLine.textContent = sandbox ? 'sandbox …' + sandbox.id.slice(-6) + ' (this tab only)' : 'none yet'
        sandboxNote.textContent = sandbox
            ? 'two leaders, board + desk · closes by ' + clock(sandbox.expiresAt)
            : 'opens on the first scenario'
        for (const service of ['board', 'desk'] as const) {
            const principal = snapshot.principals[service]
            const lines = principalLines[service]
            lines.who.textContent = principal ? principal.account + ' · roles [' + principal.roles.join(', ') + ']' : 'anonymous'
            lines.token.textContent = principal?.expiresAt != undefined
                ? 'token expires ' + clock(principal.expiresAt)
                : snapshot.notices[service] || 'no token presented'
        }
        const notes = snapshot.notes.board
        notesLine.textContent = notes ? notes.length + ' note(s)' : '—'
        notesNote.textContent = notes?.length
            ? notes.slice(-3).map(note => note.by + ': ' + note.text).join(' · ')
            : 'from the last command receipt'
        renderStatus(sandbox != null)
    }

    function renderStatus(live: boolean) {
        statusBadge.textContent = busy ? 'running' : failedLast ? 'unexpected' : live ? 'sandbox live' : 'no sandbox'
        statusBadge.dataset['state'] = busy ? 'connecting' : failedLast ? 'stale' : live ? 'live' : 'idle'
        for (const button of Object.values(buttons)) button.disabled = busy
        resetButton.disabled = busy
    }

    // ============== the verdict list: newest run on top, every step names its decider ==============

    function row(text: string, tone?: tTone) {
        const line = document.createElement('div')
        line.className = 'authLogRow'
        if (tone) line.dataset['tone'] = tone
        // server words arrive here: text only, never markup
        line.textContent = text
        return line
    }

    function verdictRows(item: ServiceTokenVerdict) {
        const matched = item.outcome == item.expected
        const head = (matched ? '' : 'UNEXPECTED ') + item.outcome.toUpperCase() + ' · ' + item.step
        return [
            row(head, matched ? (item.outcome == 'allowed' ? 'good' : undefined) : 'bad'),
            // markup collapses leading spaces, so the arrow carries the indent
            row('↳ decided by ' + serviceTokenLayers[item.layer] + ' — ' + item.detail),
        ]
    }

    function renderReport(report: ServiceTokenReport) {
        const matched = report.verdicts.filter(item => item.outcome == item.expected).length
        const summary = serviceTokenScenarios[report.scenario] + ' — '
            + (report.error
                ? 'stopped: ' + report.error
                : report.ok ? matched + '/' + report.verdicts.length + ' as the 3.0.1 contract says'
                    : (report.verdicts.length - matched) + ' step(s) UNEXPECTED')
        const block = document.createDocumentFragment()
        block.append(row('▶ ' + summary, report.ok ? 'good' : 'bad'))
        for (const item of report.verdicts) block.append(...verdictRows(item))
        verdictBox.prepend(block)
        while (verdictBox.children.length > 120) verdictBox.lastChild?.remove()
        resultLine.textContent = summary
        log('service tokens: ' + summary)
    }

    async function run(scenario: tServiceTokenScenario) {
        if (busy) return
        busy = true
        renderStatus(client.view.snapshot().sandbox != null)
        try {
            const report = await client.control.run(scenario)
            failedLast = !report.ok
            renderReport(report)
        } finally {
            busy = false
            renderSnapshot(client.view.snapshot())
        }
    }

    for (const scenario of Object.keys(buttons) as tServiceTokenScenario[]) {
        buttons[scenario].addEventListener('click', function onServiceTokenScenario() { void run(scenario) })
    }
    resetButton.addEventListener('click', function onServiceTokenReset() {
        if (busy) return
        failedLast = false
        client.control.reset()
        resultLine.textContent = 'sandbox dropped — the next scenario opens a fresh one'
    })
    client.events.changed.on(renderSnapshot)
    renderSnapshot(client.view.snapshot())

    return {
        close() { client.close() },
    }
}

export type ServiceTokenDemo = ReturnType<typeof setupServiceTokenDemo>
