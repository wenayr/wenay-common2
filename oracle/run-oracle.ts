// =====================================================================
//  runOracle(main): the one way an oracle script ends.
//
//  An async main() whose promise never settles (a listener never called, a closed line awaited)
//  lets the event loop empty, and Node exits 0 — the runner then reports a stalled oracle as
//  green while its remaining checks never ran. replay/replicated-map.test.ts hid ten failing
//  checks that way. runOracle turns "the loop emptied before main() settled" into exit code 1,
//  a thrown main() into exit code 1, and keeps an explicit process.exit(code) as the deliberate
//  ending it is. scripts/run-oracles.mjs refuses an oracle that does not end through it.
// =====================================================================

export function runOracle(main: () => unknown) {
    let settled = false
    const exit = process.exit.bind(process)
    // an explicit process.exit(code) inside main is a deliberate ending, not a stall
    process.exit = function exitDeliberately(code?: number | string | null) {
        settled = true
        return exit(code as number)
    } as typeof process.exit
    process.on('exit', function guardUnsettled() {
        if (settled) return
        console.error('FAIL oracle stopped before main() settled: an awaited promise never resolved and the event loop emptied')
        process.exitCode = 1
    })
    Promise.resolve().then(main).then(function settledMain() {
        settled = true
    }, function failedMain(error) {
        settled = true
        console.error('FAIL oracle main() threw:', error)
        process.exitCode = 1
    })
}
