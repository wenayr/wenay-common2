// Compile-only fixture (checked by clientapiall-replay-types.spec.ts via `tsc --noEmit`).
// Contract: replay-listen members of an rpc<T>() client project into the client replay
// surface (ReplaySocketListen) in BOTH typed paths (func/strict) — so
// `replaySubscribe(client.func.key, cb)` needs NO casts. Never executed at runtime.

import {createRpcClient} from '../../src/Common/rcp/rpc-client'
import type {ListenReplayApi, ReplayEvent} from '../../src/Common/events/replay-listen'
import {replaySubscribe} from '../../src/Common/events/replay-wire'

type tMsg = {text: string, n: number}
type tApi = {
    hello(name: string): string
    listenMsg: ListenReplayApi<[tMsg]>
    nested: {inner: ListenReplayApi<[number, string]>}
}

// exact-type equality (invariant check, not just assignability)
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

declare const socket: any

export function compileCase() {
    const client = createRpcClient<tApi>({socket, socketKey: 'x'})

    // the projected member carries the exact envelope type on its line
    type tProjectedEv = Parameters<Parameters<typeof client.func.listenMsg.line.on>[0]>[0]
    const evExact: Eq<tProjectedEv, ReplayEvent<[tMsg]>> = true
    void evExact

    // inferred subscribe — no casts, cb args typed from the API shape
    const sub = replaySubscribe(client.func.listenMsg, function onMsg(msg) {
        const text: string = msg.text
        void text
    })
    const seq: number = sub.seq()
    void seq
    sub()

    // explicit generic — remote param accepted with no casts
    const sub2 = replaySubscribe<[number, string]>(client.func.nested.inner, function onPair(n, s) {
        const a: number = n
        const b: string = s
        void a; void b
    })
    sub2()

    // strict path projects the same way
    const sub3 = replaySubscribe(client.strict.listenMsg, function onMsg2(msg) {
        const n: number = msg.n
        void n
    })
    sub3()

    // current subscription options stay typed on the projected RPC Listen surface
    const current = client.func.listenMsg.on(function onCurrent(msg) {
        const text: string = msg.text
        void text
    }, {current: true})
    current()

    // plain functions are untouched by the replay arm
    const p: Promise<string> = client.func.hello('x')
    void p
}
