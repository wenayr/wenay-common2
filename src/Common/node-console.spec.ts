import assert from 'node:assert/strict'

const methodNames = [
    'debug', 'info', 'log', 'warn', 'error', 'group', 'groupCollapsed', 'table', 'timeLog', 'timeEnd',
    'count', 'assert', 'dir', 'dirxml'
] satisfies (keyof typeof console)[]
type tConsoleMethod = typeof methodNames[number]

async function main() {
    const originals = new Map<tConsoleMethod, any>()
    for (const methodName of methodNames) originals.set(methodName, console[methodName])

    const calls: any[][] = []
    function captureLog(...args: any[]) { calls.push(args) }
    console.log = captureLog

    try {
        await import('./core/common')
        assert.equal(console.log, captureLog, 'direct common import must not wrap console')

        const root = await import('../../src')
        assert.equal(console.log, captureLog, 'root import must not wrap console')

        const debugConsole = await import('../../src/debug-console')
        assert.equal(console.log, captureLog, 'debug-console import must not wrap console')
        debugConsole.installConsoleCallerAnnotations()
        const wrapper = console.log
        assert.notEqual(wrapper, captureLog, 'explicit install must wrap console')

        console.log('enabled')
        assert.equal(calls.length, 1)
        assert.equal(calls[0]?.[0], 'enabled')
        assert.equal(calls[0]?.[1], '')
        assert.match(calls[0]?.[2], /^file:\/\/\/.+:\d+:\d+\s+/)

        debugConsole.disable()
        assert.equal(console.log, wrapper, 'disable must leave the installed wrapper in place')
        console.log('disabled')
        assert.deepEqual(calls[1], ['disabled'], 'disabled wrapper must delegate arguments unchanged')

        debugConsole.enable()
        assert.equal(console.log, wrapper, 'enable must not install a second wrapper')
        console.log('enabled again')
        assert.equal(calls[2]?.[0], 'enabled again')
        assert.equal(calls[2]?.[1], '')
        assert.match(calls[2]?.[2], /^file:\/\/\/.+:\d+:\d+\s+/)

        debugConsole.enable(false)
        assert.equal(console.log, wrapper, 'enable(false) must use the transparent disabled mode')
        console.log('disabled again')
        assert.deepEqual(calls[3], ['disabled again'])

        assert.equal(root.installConsoleCallerAnnotations, debugConsole.installConsoleCallerAnnotations)
    } finally {
        for (const [methodName, original] of originals) (console as any)[methodName] = original
    }

    console.log('Console caller annotation opt-in tests passed')
}

main().catch(function testFailed(error) {
    console.error(error)
    process.exitCode = 1
})
