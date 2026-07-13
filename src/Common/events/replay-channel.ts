// =====================================================================
// Replay wire over a plain message channel (datachannel, worker, pipe)
// =====================================================================
// Тот же контракт, что exposeReplay ⇄ replaySubscribe, но транспорт — любой
// упорядоченный канал строковых сообщений: WebRTC datachannel, MessagePort,
// worker, in-proc pipe. RPC-ядро не участвует: крошечный JSON req/res-протокол
// ({t:'sub'|'req'|'ev'|'res'}), потому что прямой канал живёт ВНЕ основного
// rpc-соединения — в этом весь смысл direct-маршрута.
// Закрытие канала = не-конверт (null) в line — replay-подписчики шумят, не молчат.

import {ReplayRemote} from './replay-wire'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const REPLAY_BYTES = '__wenayReplayBytes'

// JSON is still the envelope protocol, but a direct channel must not turn a media
// Uint8Array into an object with numeric keys. Keep bytes explicit and portable:
// this runs in browsers and Node without depending on Buffer or lib.dom types.
function bytesToBase64(bytes: Uint8Array) {
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = bytes[i + 1]
        const c = bytes[i + 2]
        out += BASE64[a >> 2]
        out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]
        out += b == null ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]
        out += c == null ? '=' : BASE64[c & 63]
    }
    return out
}

function base64ToBytes(text: string) {
    const clean = text.replace(/=+$/, '')
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
    let bits = 0
    let nBits = 0
    let at = 0
    for (const char of clean) {
        const n = BASE64.indexOf(char)
        if (n < 0) throw new Error('replay channel: invalid binary payload')
        bits = (bits << 6) | n
        nBits += 6
        if (nBits < 8) continue
        nBits -= 8
        out[at++] = (bits >> nBits) & 255
    }
    return out
}

function stringifyMessage(value: unknown) {
    return JSON.stringify(value, function encodeReplayBytes(_key, item) {
        if (item instanceof Uint8Array) return {[REPLAY_BYTES]: bytesToBase64(item)}
        return item
    })
}

function parseMessage(raw: string) {
    return JSON.parse(raw, function decodeReplayBytes(_key, item) {
        if (item != null && typeof item == 'object' && Object.keys(item).length == 1 && typeof item[REPLAY_BYTES] == 'string') {
            return base64ToBytes(item[REPLAY_BYTES])
        }
        return item
    })
}

/** Минимальный упорядоченный канал строк — форма datachannel/MessagePort/pipe. */
export type ReplayMessageChannel = {
    send: (data: string) => void
    onMessage: (cb: (data: string) => void) => (() => void) | void
    onClose?: (cb: () => void) => (() => void) | void
    close?: () => void
}

// хендл отписки бывает функцией (Listen) или объектом (SubscriptionHandle провода)
function unsubscribeHandle(handle: any) {
    if (typeof handle == 'function') { handle(); return }
    if (typeof handle?.off == 'function') handle.off()
    else if (typeof handle?.unsubscribe == 'function') handle.unsubscribe()
}

/**
 * Серверная сторона: отдать replay-линию (форма exposeReplay/ReplayRemote)
 * в канал. Линия подписывается лениво — по первому {t:'sub'} потребителя.
 * Возвращает close() (снять line-подписку и перестать отвечать).
 */
export function serveReplayChannel<Z extends any[]>(source: ReplayRemote<Z>, channel: ReplayMessageChannel) {
    let lineOff: any = null
    let closed = false

    async function handleRequest(msg: {id: number, m: string, a: any[]}) {
        try {
            const v = msg.m == 'since' ? await source.since(msg.a[0])
                : msg.m == 'keyframe' ? await source.keyframe()
                : msg.m == 'frame' ? (source.frame ? await source.frame(msg.a[0], msg.a[1]) : null)
                : undefined
            if (!closed) channel.send(stringifyMessage({t: 'res', id: msg.id, ok: true, v: v ?? null}))
        } catch (e) {
            // священная линия и прочие броски едут потребителю громко, как в rpc-проекции
            if (!closed) channel.send(stringifyMessage({t: 'res', id: msg.id, ok: false, e: String(e)}))
        }
    }

    const offMsg = channel.onMessage(function onReplayChannelMessage(raw) {
        if (closed) return
        let msg: any
        try { msg = parseMessage(raw) } catch { return }
        if (msg?.t == 'sub' && !lineOff) {
            lineOff = source.line.on(function forwardEnvelope(ev: any) {
                if (!closed) channel.send(stringifyMessage({t: 'ev', ev}))
            })
            return
        }
        if (msg?.t == 'req') void handleRequest(msg)
    })

    function close() {
        if (closed) return
        closed = true
        unsubscribeHandle(lineOff)
        lineOff = null
        if (typeof offMsg == 'function') offMsg()
    }
    channel.onClose?.(close)
    return close
}

/**
 * Клиентская сторона: ReplayRemote поверх канала — скармливается любому
 * replaySubscribe / replayRouteSubscribe / syncStoreReplay как обычный remote.
 */
export function channelReplayRemote<Z extends any[]>(channel: ReplayMessageChannel): ReplayRemote<Z> {
    let nextId = 1
    let subscribed = false
    let closed = false
    const pending = new Map<number, {resolve: (v: any) => void, reject: (e: any) => void}>()
    const lineCbs = new Set<(ev: any) => void>()

    channel.onMessage(function onRemoteChannelMessage(raw) {
        let msg: any
        try { msg = parseMessage(raw) } catch { return }
        if (msg?.t == 'ev') {
            for (const cb of Array.from(lineCbs)) cb(msg.ev)
            return
        }
        if (msg?.t == 'res') {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            if (!p) return
            if (msg.ok) p.resolve(msg.v)
            else p.reject(new Error(msg.e ?? 'replay channel request failed'))
        }
    })

    channel.onClose?.(function onRemoteChannelClosed() {
        if (closed) return
        closed = true
        for (const [, p] of pending) p.reject(new Error('replay channel closed'))
        pending.clear()
        // не-конверт = конец линии: replayRouteSubscribe/replaySubscribe репортят onError
        for (const cb of Array.from(lineCbs)) cb(null)
        lineCbs.clear()
    })

    function req(m: string, a: any[]) {
        if (closed) return Promise.reject(new Error('replay channel closed'))
        return new Promise<any>((resolve, reject) => {
            const id = nextId++
            pending.set(id, {resolve, reject})
            channel.send(stringifyMessage({t: 'req', id, m, a}))
        })
    }

    return {
        line: {
            on(cb: (ev: any) => void) {
                lineCbs.add(cb)
                if (!subscribed && !closed) {
                    subscribed = true
                    channel.send(JSON.stringify({t: 'sub'}))
                }
                return function offChannelLine() { lineCbs.delete(cb) }
            },
        },
        since: seq => req('since', [seq]),
        keyframe: () => req('keyframe', []),
        frame: (seq, hint) => req('frame', [seq, hint]),
    }
}
