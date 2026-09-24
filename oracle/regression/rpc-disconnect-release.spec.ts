// Regression: the core server must release auth timers/flows on transport disconnect. A grant
// with a future deadline arms a timer that closes over the whole server (socket + facade); with
// no disconnect path those live until another server takes the socket+key. createRpcServerAuto
// relays its disconnectListen into the core teardown. Repro r7.
//
// GC proof: the facade behind a +1h grant stays reachable while the deadline is pending, and
// becomes collectible after disconnect. Runs under --expose-gc (self-respawns if needed).
import {spawnSync} from 'node:child_process'
import {runOracle} from '../run-oracle'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

if (typeof (globalThis as any).gc != 'function') {
    const res = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', __filename, '--child'], {stdio: 'inherit'})
    process.exit(res.status ?? 1)
}

// dynamic import so the respawn path above pays nothing before it has --expose-gc
async function main() {
    const {createRpcServerAuto} = await import('../../src/Common/rcp/rpc-server-auto')
    const {listen} = await import('../../src/Common/events/Listen')
    const gc = (globalThis as any).gc as () => void

    let failures = 0
    function check(name: string, cond: boolean, detail?: string) {
        console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + (detail ?? '')}`)
        if (!cond) failures++
    }

    async function collected(ref: WeakRef<object>) {
        for (let i = 0; i < 8; i++) { gc(); await delay(10) }
        return ref.deref() == undefined
    }

    // grant a +1h deadline and NEVER disconnect: the pending timer must keep the facade reachable
    function openRetained() {
        const socket = {emit() {}, on() {}}
        const [, goneListen] = listen<[]>()
        const facade = {big: new Array(1e5).fill(0)}
        const {control} = createRpcServerAuto({
            socket, socketKey: 'k', object: {},
            auth: {gate: true, resolveAuth: () => ({object: facade})}, disconnectListen: goneListen,
        })
        control.grant({object: facade, ack: {ok: true}, expiresAt: Date.now() + 3600_000})
        return new WeakRef(facade)
    }

    // same, but fire the disconnect before dropping the references
    function openReleased() {
        const socket = {emit() {}, on() {}}
        const [gone, goneListen] = listen<[]>()
        const facade = {big: new Array(1e5).fill(0)}
        const {control} = createRpcServerAuto({
            socket, socketKey: 'k2', object: {},
            auth: {gate: true, resolveAuth: () => ({object: facade})}, disconnectListen: goneListen,
        })
        control.grant({object: facade, ack: {ok: true}, expiresAt: Date.now() + 3600_000})
        gone() // transport disconnect
        return new WeakRef(facade)
    }

    const retained = openRetained()
    check('facade retained while the grant deadline is pending', !(await collected(retained)))

    const released = openReleased()
    check('facade released after transport disconnect', await collected(released))

    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}
runOracle(main)
