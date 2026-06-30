import { createRpcServer, type PromiseServerHooks, type RpcLimits, type RpcServerAuth, type RpcOpt } from './rpc-server'
import { createRpcServerAuto } from './rpc-server-auto'
import { createRpcClient } from './rpc-client'
import type { SocketTmpl } from './rpc-protocol'
import type { DeepSocketListen } from './listen-deep'

// ===================================================================
// IN-PROC TRANSPORT (Tier 1, BACK-BACK enabler)
// -------------------------------------------------------------------
// Сервер и клиент в ОДНОМ процессе: пара in-memory SocketTmpl несёт ровно тот
// же провод, что и сеть. Переиспользует ВЕСЬ код ядра (pack/unpack, дедуп,
// MAP/STRICT/HELLO, off()-хендлы, throttle, лимиты, auth) — без новой семантики.
//
// ЧЕСТНАЯ ГРАНИЦА: это in-PROC, НЕ zero-cost. Каждое сообщение проходит JSON-клон
// (как реальный транспорт и как rpc.harness.spec.ts:createLoopback), поэтому
// Date/Map/BigInt round-trip и дедуп байт-в-байт идентичны проду. Истинно
// zero-clone (by-reference) direct-call прокси — отдельный больший шаг (Tier 1b,
// меняет семантику аргументов: идентичность объектов, время жизни колбэков).
// ===================================================================

// --- resource: пара связанных SocketTmpl (тот же loopback, что в харнесе, но как экспорт) ---
export function createInProcSocketPair(): [SocketTmpl, SocketTmpl] {
    const A: Record<string, ((d: any) => void)[]> = {}
    const B: Record<string, ((d: any) => void)[]> = {}
    const make = (mine: typeof A, theirs: typeof A): SocketTmpl => ({
        on: (e, cb) => { (mine[e] ??= []).push(cb) },
        emit: (e, d) => {
            // не реентрантно (queueMicrotask) + JSON-клон: семантика провода один-в-один
            const wire = d === undefined ? undefined : JSON.parse(JSON.stringify(d))
            for (const cb of (theirs[e] ?? [])) queueMicrotask(() => cb(wire))
        },
    })
    return [make(A, B), make(B, A)] // [client, server]
}

// --- business: реальный сервер+клиент над in-proc парой ---
export function createRpcInProc<T extends object>({
    object: target,
    socketKey = 'rpc',
    listen = true,
    debug,
    hooks,
    limits,
    auth,
    token,
    throttle,
    maxPerListen,
    opt,
}: {
    object: T
    socketKey?: string
    /** true (умолч.): Listen-узлы → listenSocket, как на сети (createRpcServerAuto).
     *  false: голый createRpcServer (без авто-обёртки Listen). */
    listen?: boolean
    debug?: boolean
    hooks?: any
    limits?: RpcLimits
    auth?: RpcServerAuth
    /** С auth/gate: in-proc пара НЕ эмитит 'connect' (нет hub) — вызови у возвращённого
     *  клиента initStrict()/readyStrict(), чтобы прогнать HELLO-рукопожатие до gated-вызовов. */
    token?: any
    /** Пробрасывается в серверный listen-слой (throttle стримов) при listen:true. */
    throttle?: number
    maxPerListen?: number
    /** Оптимизации провода (договорные): { compact?: false } отключает уплотнение тиков. */
    opt?: RpcOpt
}) {
    const [clientSocket, serverSocket] = createInProcSocketPair()
    // Возвращаем КЛИЕНТ как SDK-хендл (то же место вызова, что и по сети). Серверный `{ api }`
    // от createRpcServerAuto (server-side stats) намеренно не пробрасываем — клиентский
    // api.subscriptions() даёт эквивалентный (дедуплицированный) вид; серверная сторона здесь.
    if (listen) {
        createRpcServerAuto({ socket: serverSocket, object: target as any, socketKey, debug, hooks, limits, auth, throttle, maxPerListen, opt })
    } else {
        createRpcServer({ socket: serverSocket, object: target as any, socketKey, debug, hooks: hooks as PromiseServerHooks<T>, limits, auth, opt })
    }
    return createRpcClient<DeepSocketListen<T>>({ socket: clientSocket, socketKey, limits, token, opt })
}
