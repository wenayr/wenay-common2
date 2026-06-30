// ============================================================
//  oracle/realsocket/obs-objmap.spec.ts — DISPOSABLE real-socket oracle
//  CATEGORY "obs-objmap": observable createRObject / createRMap reactive
//  nodes streamed THROUGH RPC over a genuine socket.io WebSocket.
//  Port 4202 (own port, no clash).
//
//  Covers:
//   • RObject whole-object subscription receives [key,value] updates
//   • RObject key-level subscription receives only that key's value
//   • RObject nested object mutation streams (nested.key("a").listen())
//   • RMap whole-map set/delete propagate to a remote subscriber
//   • per-node server-side refcount bookkeeping (count() 0→1→0)
//
//   node node_modules/ts-node/dist/bin.js --transpile-only oracle/realsocket/obs-objmap.spec.ts
// ============================================================
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'
import {createRObject, createRMap} from '../../observable/reactive'

const PORT = 4202

// ── nodes in OUTER scope so the test can mutate them after the client
//    subscribes; makeObject (per-connection) only hands out .listen() handles.
const obj = createRObject<{x: number; y: number}>({x: 1, y: 2})
const nested = createRObject<{a: number; b: number}>({a: 0, b: 0})
const map = createRMap<string, number>([['a', 1]])

function makeObject() {
    return {
        // whole-object [key,value] stream + key-level single-value stream
        obj: obj.listen(),
        objX: obj.key('x').listen(),
        // nested object exposed as a sub-facade: nested.key("a").listen()
        nested: {a: nested.key('a').listen()},
        // whole-map [key,value] stream (delete emits value null over the wire)
        map: map.listen(),
    }
}

async function main() {
    const {check, done} = makeChecker('obs-objmap')
    const watchdog = setTimeout(() => { console.error('WATCHDOG timeout'); process.exit(3) }, 45000)

    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient({port: PORT})
    const api = cli.api

    // ===== 1. RObject whole-object subscription: receives [key,value] deltas =====
    const whole: any[] = []
    const subWhole: any = (api as any).obj.callback((k: any, v: any) => whole.push([k, v]))
    // ===== 2. RObject key-level subscription: receives only that key's value =====
    const onX: number[] = []
    const subX: any = (api as any).objX.callback((v: any) => onX.push(v))
    await delay(60) // subscription round-trips over the real socket

    await check('whole-object refcount = 1 after subscribe', () => obj.listen().count(), 1)
    await check('key-level (x) refcount = 1 after subscribe', () => obj.key('x').count(), 1)

    obj.set('y', 20)
    obj.set('x', 10)
    await delay(60)

    await check('whole-object stream sees both deltas over real socket',
        async () => JSON.stringify(whole), '[["y",20],["x",10]]')
    await check('key-level (x) stream sees ONLY x',
        async () => JSON.stringify(onX), '[10]')

    // ===== 3. RObject nested mutation streams via nested.key("a").listen() =====
    const onNestedA: number[] = []
    const subNested: any = (api as any).nested.a.callback((v: any) => onNestedA.push(v))
    await delay(60)
    await check('nested key (a) refcount = 1 after subscribe', () => nested.key('a').count(), 1)

    nested.set('a', 7)
    nested.set('b', 99) // must NOT reach the a-subscriber
    nested.set('a', 8)
    await delay(60)
    await check('nested object mutation streams ONLY key a',
        async () => JSON.stringify(onNestedA), '[7,8]')

    // ===== 4. RMap set / delete propagate to the remote subscriber =====
    //  Over the wire a deletion's `undefined` value serializes to null.
    const mapEv: any[] = []
    const subMap: any = (api as any).map.callback((k: any, v: any) => mapEv.push([k, v]))
    await delay(60)
    await check('rmap whole-map refcount = 1 after subscribe', () => map.listen().count(), 1)

    map.set('b', 2)
    map.delete('a')
    map.set('c', 3)
    await delay(60)
    await check('rmap set/delete propagate to remote subscriber',
        async () => JSON.stringify(mapEv), '[["b",2],["a",null],["c",3]]')

    // ===== 5. unsubscribe each node → server-side refcount returns to 0 =====
    subWhole.unsubscribe?.()
    subX.unsubscribe?.()
    subNested.unsubscribe?.()
    subMap.unsubscribe?.()
    await delay(80)

    await check('whole-object cold again after unsubscribe (refcount 0)', () => obj.listen().count(), 0)
    await check('key-level (x) cold again after unsubscribe (refcount 0)', () => obj.key('x').count(), 0)
    await check('nested key (a) cold again after unsubscribe (refcount 0)', () => nested.key('a').count(), 0)
    await check('rmap whole-map cold again after unsubscribe (refcount 0)', () => map.listen().count(), 0)

    // ===== 6. after unsubscribe, further mutations do NOT reach the client =====
    obj.set('x', 999)
    map.set('d', 4)
    nested.set('a', 1000)
    await delay(60)
    await check('no whole-object events after unsubscribe', async () => JSON.stringify(whole), '[["y",20],["x",10]]')
    await check('no key-level events after unsubscribe', async () => JSON.stringify(onX), '[10]')
    await check('no nested events after unsubscribe', async () => JSON.stringify(onNestedA), '[7,8]')
    await check('no rmap events after unsubscribe', async () => JSON.stringify(mapEv), '[["b",2],["a",null],["c",3]]')

    clearTimeout(watchdog)
    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
