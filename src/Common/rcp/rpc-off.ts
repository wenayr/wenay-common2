// rpc-off.ts
//

import { rpcEndCallback } from "./rpc-walk"

// Idiomatic short alias for rpcEndCallback: prefix `rpc` — noise, name
// is imported from rpc namespace. Stream verbs here — END (CB_END / *End),
// so endCallback holds single verb. Additive: rpcEndCallback lives on.
/** End streaming callback (sends "___STOP" to client). */
export const endCallback = rpcEndCallback

//
// ============================================================
// Utility: "callable thenable" (callable thenable) — off idiom
// ============================================================
// SINGLE source of truth for `off = sub; off()` idiom in ALL subscription layers
// (CALL-dedup and PIPE in rpc-client; listen-socket layer). Subscription returns
// ONE handle which simultaneously:
//   - called as function  -> off() removes subscription (body passed by layer);
//   - is thenable         -> await off resolves exactly like original promise
//                            (stream end / break); .then/.catch/.finally
//                            forwarded to it;
//   - carries back-compat fields -> extra (e.g. { unsubscribe } for rpc-client,
//                                    { removeCallback } for listen-socket).
// Layer-agnostic: knows only promise + off, nothing about sockets/Listen —
// so sits BELOW both subscription layers. off() is idempotent (done flag).

type tThenable<V> = {
    then: Promise<V>['then']
    catch: Promise<V>['catch']
    finally: Promise<V>['finally']
}
export type Off<V = void, X extends object = {}> = (() => void) & tThenable<V> & X

export function makeOff<V, X extends object = {}>(promise: Promise<V>, stop: () => void, extra?: X) {
    let done = false
    // named — visible in stack traces as off, not <anonymous>; idempotent
    function off() {
        if (done) return
        done = true
        stop()
    }
    const handle = off as any
    // .then/.catch/.finally — forward to original promise: await handle == await promise
    handle.then = promise.then.bind(promise)
    handle.catch = promise.catch.bind(promise)
    handle.finally = promise.finally.bind(promise)
    if (extra) Object.assign(handle, extra)
    return handle as Off<V, X>
}
