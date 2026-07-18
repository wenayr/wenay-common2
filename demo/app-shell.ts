export const demoViews = ['rooms', 'store', 'lab'] as const

export type tDemoView = typeof demoViews[number]

type AppShellDeps = {
    root: Document
    initial?: tDemoView
}

function viewFromHash(hash: string) {
    const requested = hash.replace(/^#\/?/, '') as tDemoView
    return demoViews.includes(requested) ? requested : undefined
}

export function setupAppShell(deps: AppShellDeps) {
    const buttons = Array.from(deps.root.querySelectorAll<HTMLButtonElement>('[data-view-button]'))
    const views = Array.from(deps.root.querySelectorAll<HTMLElement>('[data-view]'))
    let current = viewFromHash(location.hash) ?? deps.initial ?? 'rooms'

    function render() {
        for (const button of buttons) {
            const selected = button.dataset.viewButton == current
            button.classList.toggle('selected', selected)
            button.setAttribute('aria-selected', String(selected))
        }
        for (const view of views) view.hidden = view.dataset.view != current
    }

    function show(view: tDemoView, updateHash = true) {
        current = view
        if (updateHash && location.hash != '#' + view) history.replaceState(null, '', '#' + view)
        render()
    }

    for (const button of buttons) {
        button.addEventListener('click', function selectDemoView() {
            const view = button.dataset.viewButton as tDemoView
            if (demoViews.includes(view)) show(view)
        })
    }

    function onHashChange() {
        const view = viewFromHash(location.hash)
        if (view) show(view, false)
    }
    window.addEventListener('hashchange', onHashChange)
    show(current, false)

    return {
        show,
        current: () => current,
        close() { window.removeEventListener('hashchange', onHashChange) },
    }
}
