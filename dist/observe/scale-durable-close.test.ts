// ============================================================
//  observe/scale-durable-close.test.ts
//
//  Found by the scaffold's migrate oracle: the Store drains its batch
//  asynchronously, so an authority closed right after an ACKNOWLEDGED command
//  had not yet handed that batch to the archive — a graceful shutdown (SIGTERM
//  → close()) lost the last writes of the lifetime, and the next boot restored
//  a state the client had already seen confirmed. close() must flush the line
//  into the archive first. Control: with a delay before close the archive was
//  always complete, which is why the durable oracle never saw it.
//  Run: node node_modules/tsx/dist/cli.mjs observe/scale-durable-close.test.ts
// ============================================================

import {createAuthority} from '../src/Common/scale/scale-authority'
import {createMemoryReplayStorage} from '../src/Common/events/replay-history'

type State = {counter: {value: number}}

let fails = 0
let step = 0
const ok = (condition: any, message: string) => {
    const label = String(++step).padStart(2, ' ')
    if (!condition) { fails++; console.log(`${label}. FAIL ${message}`) }
    else console.log(`${label}. OK   ${message}`)
}
const quiet = () => {}

function boot(storage: ReturnType<typeof createMemoryReplayStorage>) {
    const authority = createAuthority<State, {add: (ctx: any, input: {delta: number}) => {value: number}}>({
        line: {storeId: 'close-line', originId: 'close-origin', initial: {counter: {value: 0}}, durable: {storage, everyEvents: 1000}},
        roster: {url: () => 'mem://authority'},
        identity: {issue: account => 'tok:' + account, verify: presented => ({account: String(presented).slice(4)})},
        corridor: {commands: {add(_ctx, input) { authority.line.control.store.state.counter = {value: authority.line.control.store.state.counter.value + input.delta}; return {value: authority.line.control.store.state.counter.value} }}},
        log: quiet,
    })
    authority.start()
    return authority
}

async function main() {
    const storage = createMemoryReplayStorage()
    const first = boot(storage)
    const acked = await first.corridor.execute('alice', 'add', 'r1', {delta: 5})
    ok(acked.value == 5 && first.line.control.store.state.counter.value == 5, 'the command is acknowledged and applied')
    // no delay: the process is told to stop right after answering the client
    first.close()
    const second = boot(storage)
    ok(second.view.restored()?.fromArchive == true, 'the next lifetime boots from the archive')
    ok(second.line.control.store.state.counter.value == 5, `the acknowledged write survived an immediate close (${second.line.control.store.state.counter.value})`)
    ok((second.view.restored()?.seq ?? 0) >= 1, `the seq space continued (${second.view.restored()?.seq})`)

    // control: with a drain delay before close the archive was complete all along
    const controlStorage = createMemoryReplayStorage()
    const third = boot(controlStorage)
    await third.corridor.execute('alice', 'add', 'r1', {delta: 7})
    await new Promise(resolve => setTimeout(resolve, 50))
    third.close()
    const fourth = boot(controlStorage)
    ok(fourth.line.control.store.state.counter.value == 7, 'control: a close after the drain always archived the write')

    second.close()
    fourth.close()
    console.log(fails == 0 ? '\nscale-durable-close: ALL GREEN' : `\nscale-durable-close: ${fails} FAILURES`)
    process.exit(fails ? 1 : 0)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
