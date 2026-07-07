// rpc-off.ts
//

import { rpcEndCallback } from "./rpc-walk"

// Идиоматичный короткий алиас для rpcEndCallback: префикс `rpc` — шум, имя
// импортируется из rpc-неймспейса. Вербы потока здесь — END (CB_END / *End),
// поэтому endCallback держит единый глагол. Аддитивно: rpcEndCallback живёт.
/** Завершить стримовый колбэк (шлёт «___STOP» клиенту). */
export const endCallback = rpcEndCallback

//
// ============================================================
// Утилита: «вызываемый thenable» (callable thenable) — идиома off
// ============================================================
// ЕДИНЫЙ источник истины для идиомы `off = sub; off()` во ВСЕХ слоях подписки
// (CALL-дедуп и PIPE в rpc-client; listen-socket-слой). Подписка отдаёт
// ОДИН handle, который одновременно:
//   - вызывается как функция  -> off() снимает подписку (тело передаёт слой);
//   - является thenable       -> await off резолвится ровно как исходный промис
//                                (конец стрима / разрыв); .then/.catch/.finally
//                                проброшены на него;
//   - несёт back-compat поля  -> extra (напр. { unsubscribe } для rpc-client,
//                                { removeCallback } для listen-socket).
// Слой-нейтрально: знает только про промис + off, ничего про сокеты/Listen —
// поэтому лежит НИЖЕ обоих слоёв подписки. off() идемпотентен (флаг done).

type tThenable<V> = {
    then: Promise<V>['then']
    catch: Promise<V>['catch']
    finally: Promise<V>['finally']
}
export type Off<V = void, X extends object = {}> = (() => void) & tThenable<V> & X

export function makeOff<V, X extends object = {}>(promise: Promise<V>, stop: () => void, extra?: X) {
    let done = false
    // именованная — видна в стектрейсах как off, а не <anonymous>; идемпотентна
    function off() {
        if (done) return
        done = true
        stop()
    }
    const handle = off as any
    // .then/.catch/.finally — на исходный промис: await handle == await promise
    handle.then = promise.then.bind(promise)
    handle.catch = promise.catch.bind(promise)
    handle.finally = promise.finally.bind(promise)
    if (extra) Object.assign(handle, extra)
    return handle as Off<V, X>
}
