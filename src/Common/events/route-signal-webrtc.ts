// =====================================================================
// WebRTC signaling adapter over the existing socket/RPC control channel
// =====================================================================
// Шаг 9 route-координатора: сигналинг (offer/answer/ICE/session/revoke) едет
// по УЖЕ СУЩЕСТВУЮЩЕМУ relay-каналу — порт хаба это {send, signals}, т.е.
// функция + Listen, ровно то, что createRpcServerAuto экспонирует без доработок.
// Сам RTCPeerConnection в библиотеку НЕ входит: коннектор берёт фабрику
// `rtc: () => RtcPeerConnection` (структурный тип, без lib.dom) — браузер
// подставляет `() => new RTCPeerConnection(cfg)`, Node — werift/node-datachannel,
// тесты — in-proc фейк. Приватность: endpoint/session-материал раскрывается
// только через authorize-хук ХАБА (серверная точка canExposeEndpoint) — клиентская
// policy координатора остаётся advisory-слоем, сервер решает окончательно.

import {listen} from './Listen'
import {ReplayRemote} from './replay-wire'
import {RouteConnector, tConnectorState} from './route-coordinator'
import {channelReplayRemote, ReplayMessageChannel, serveReplayChannel} from './replay-channel'

// =====================================================================
// Signaling protocol
// =====================================================================

// call-типы едут по ТОМУ ЖЕ хабу (peer-call): маршрутизация по `to` их не различает,
// webrtc-коннекторы фильтруют по pair+типу — интерференции нет; серверный authorize
// видит и их (единая точка серверной политики: endpoint-материал И звонки)
export type tSignalType = 'offer' | 'answer' | 'ice' | 'revoke' | 'close'
    | 'ring' | 'accept' | 'decline' | 'hangup'

export type SignalEnvelope = {
    type: tSignalType
    /** Симметричный ключ пары (RoutePairRef.key). */
    pair: string
    from: string
    to: string
    sdp?: string
    candidate?: unknown
    /** Opaque auth/session-материал: провод не заглядывает, валидирует policy/accept. */
    session?: unknown
    reason?: string
}

/** Клиентский вид сигнального порта — то, что доезжает через rpc-проекцию. */
export type SignalPort = {
    /** false = сервер отказал (authorize/нет адресата) — direct даже не пытаемся. */
    send: (env: SignalEnvelope) => Promise<boolean | void> | boolean | void
    signals: {on: (cb: (env: SignalEnvelope) => void) => any}
}

/**
 * Серверный сигнальный хаб: маршрутизирует конверты между аккаунтами.
 * register(account) -> порт этого аккаунта; его форма {send, signals} готова
 * к экспорту через createRpcServerAuto (send = функция, signals = Listen).
 * authorize — единственная точка, где endpoint/session-материал разрешается
 * к раскрытию (canExposeEndpoint серверной policy); подмена from невозможна.
 */
export function createSignalHub(deps: {authorize?: (env: SignalEnvelope) => boolean | Promise<boolean>} = {}) {
    const {authorize} = deps
    // Several browser tabs may share one account. Keep registration order and route
    // to the newest live port; when it closes, the previous port becomes active again.
    const ports = new Map<string, Array<(env: SignalEnvelope) => void>>()

    function register(account: string) {
        const [emit, signals] = listen<[SignalEnvelope]>()
        const accountPorts = ports.get(account) ?? []
        accountPorts.push(emit)
        ports.set(account, accountPorts)

        async function send(env: SignalEnvelope) {
            if (env == null || env.from != account) return false // spoofing отрезан на входе
            if (authorize && !(await authorize(env))) return false
            const targets = ports.get(env.to)
            const target = targets?.[targets.length - 1]
            if (!target) return false
            target(env)
            return true
        }

        function close() {
            const accountPorts = ports.get(account)
            if (accountPorts) {
                const i = accountPorts.indexOf(emit)
                if (i >= 0) accountPorts.splice(i, 1)
                if (!accountPorts.length) ports.delete(account)
            }
            signals.close()
        }

        return {account, send, signals, close}
    }

    /** Серверный отзыв маршрута (policy сменилась): revoke обеим сторонам пары. */
    function revoke(pair: string, accounts: string[], reason?: string) {
        for (const account of accounts) {
            const accountPorts = ports.get(account)
            accountPorts?.[accountPorts.length - 1]?.({type: 'revoke', pair, from: '', to: account, reason})
        }
    }

    return {
        register,
        revoke,
        accounts: () => Array.from(ports.keys()),
        close() {
            ports.clear()
        },
    }
}

export type SignalHub = ReturnType<typeof createSignalHub>

// =====================================================================
// Structural WebRTC types — ровно та часть браузерного API, которую мы
// трогаем; без lib.dom, чтобы Node-сборка и фейки жили без каста.
// =====================================================================

export type RtcSessionDescription = {type: string, sdp?: string}

export type RtcDataChannel = {
    send: (data: string) => void
    close: () => void
    onopen?: ((ev?: unknown) => void) | null
    onmessage?: ((ev: {data: unknown}) => void) | null
    onclose?: ((ev?: unknown) => void) | null
    onerror?: ((ev?: unknown) => void) | null
}

export type RtcPeerConnection = {
    createDataChannel: (label: string, opts?: unknown) => RtcDataChannel
    createOffer: () => Promise<RtcSessionDescription>
    createAnswer: () => Promise<RtcSessionDescription>
    setLocalDescription: (d: RtcSessionDescription) => Promise<unknown> | unknown
    setRemoteDescription: (d: RtcSessionDescription) => Promise<unknown> | unknown
    addIceCandidate: (c: unknown) => Promise<unknown> | unknown
    close: () => void
    onicecandidate?: ((ev: {candidate?: unknown}) => void) | null
    ondatachannel?: ((ev: {channel: RtcDataChannel}) => void) | null
}

/** ReplayMessageChannel поверх datachannel: единственный владелец его хендлеров. */
export function channelFromDataChannel(dc: RtcDataChannel): ReplayMessageChannel {
    const msgCbs = new Set<(data: string) => void>()
    const closeCbs = new Set<() => void>()
    let closed = false
    function fireClose() {
        if (closed) return
        closed = true
        for (const cb of Array.from(closeCbs)) cb()
    }
    dc.onmessage = function onDcMessage(ev) {
        const data = String(ev.data)
        for (const cb of Array.from(msgCbs)) cb(data)
    }
    dc.onclose = fireClose
    dc.onerror = fireClose // для replay-провода ошибка канала == конец линии, шумно через onClose
    return {
        send: data => dc.send(data),
        onMessage: cb => { msgCbs.add(cb); return () => msgCbs.delete(cb) },
        onClose: cb => { closeCbs.add(cb); return () => closeCbs.delete(cb) },
        close: () => { dc.close(); fireClose() },
    }
}

// =====================================================================
// Initiator: RouteConnector, ведущий offer/answer/ICE через сигнальный порт
// =====================================================================

export type WebRtcConnectorDeps = {
    port: SignalPort
    /** Рантайм-фабрика: браузер `() => new RTCPeerConnection(cfg)`, Node — werift и т.п. */
    rtc: () => RtcPeerConnection
    self: string
    peer: string
    /** Ключ пары (RoutePairRef.key) — им фильтруются конверты. */
    pair: string
    /** Opaque session-материал в offer — валидируется authorize-хуком хаба и accept-хуком пира. */
    session?: unknown
    label?: string
    /** Сколько ждать открытия datachannel, мс. */
    openTimeoutMs?: number
}

/**
 * Direct-коннектор для координатора: чистый транспорт, никакой route-логики.
 * open() гоняет offer/answer/ICE по сигнальному порту, ждёт datachannel и
 * возвращает replay-провод поверх него. revoke/close по сигналингу и смерть
 * канала = onFail (координатор сам откатится на relay).
 */
export function createWebRtcConnector<Z extends any[] = any[]>(deps: WebRtcConnectorDeps): RouteConnector<Z> {
    const {port, rtc, self, peer, pair, session, label = 'direct', openTimeoutMs = 10_000} = deps
    let state: tConnectorState = 'idle'
    let pc: RtcPeerConnection | null = null
    let channel: ReplayMessageChannel | null = null
    let offSignals: any = null
    let abortOpen: ((e: unknown) => void) | null = null
    const [emitFail, failListen] = listen<[unknown]>()

    function teardown(next: tConnectorState) {
        state = next
        if (typeof offSignals == 'function') offSignals()
        else offSignals?.off?.()
        offSignals = null
        channel?.close?.()
        channel = null
        pc?.close()
        pc = null
    }

    function fail(reason: unknown) {
        if (state == 'closed' || state == 'failed') return
        // revoke/смерть канала ВО ВРЕМЯ open обязаны прервать ожидание громко и сразу,
        // а не оставлять инициатора ждать openTimeoutMs
        const abort = abortOpen
        abortOpen = null
        teardown('failed')
        abort?.(reason instanceof Error ? reason : new Error(String(reason)))
        emitFail(reason)
    }

    async function open() {
        state = 'opening'
        const me = rtc()
        pc = me
        const dc = me.createDataChannel('replay')
        let openTimer: any = null
        const opened = new Promise<void>((resolve, reject) => {
            abortOpen = reject
            dc.onopen = () => resolve()
            openTimer = setTimeout(function webRtcOpenTimeout() {
                reject(new Error('webrtc direct open timeout: ' + pair))
            }, openTimeoutMs)
        })
        opened.catch(() => {}) // провал ДО await opened не должен дать unhandled rejection от таймера

        offSignals = port.signals.on(function onSignal(env: SignalEnvelope) {
            if (env == null || env.pair != pair || env.to != self || pc != me) return
            if (env.type == 'answer' && env.sdp != null) {
                void Promise.resolve(me.setRemoteDescription({type: 'answer', sdp: env.sdp}))
                    .catch(fail)
                return
            }
            if (env.type == 'ice' && env.candidate != null) {
                void Promise.resolve(me.addIceCandidate(env.candidate)).catch(fail)
                return
            }
            if (env.type == 'revoke' || env.type == 'close') {
                fail(new Error('direct route ' + env.type + (env.reason ? ': ' + env.reason : '')))
            }
        })

        me.onicecandidate = function onIce(ev) {
            if (ev?.candidate != null) {
                // RTCIceCandidate — класс-инстанс: по проводу едет его JSON-инит,
                // иначе сериализация транспорта может отдать пустой объект
                const c: any = ev.candidate
                void port.send({type: 'ice', pair, from: self, to: peer, candidate: c?.toJSON ? c.toJSON() : c})
            }
        }

        try {
            const offer = await me.createOffer()
            await me.setLocalDescription(offer)
            const accepted = await port.send({type: 'offer', pair, from: self, to: peer, sdp: offer.sdp, session})
            // сервер не раскрыл endpoint (authorize) или пира нет — direct не состоится
            if (accepted == false) throw new Error('signaling rejected offer (endpoint not exposed): ' + pair)
            await opened
        } catch (e) {
            teardown('failed')
            throw e
        } finally {
            clearTimeout(openTimer)
            abortOpen = null
        }
        state = 'open'
        channel = channelFromDataChannel(dc)
        channel.onClose?.(function onDirectChannelDied() {
            if (state == 'open') fail(new Error('direct channel closed: ' + pair))
        })
        return channelReplayRemote<Z>(channel)
    }

    return {
        info: {label, kind: 'direct', binary: false, ordered: true, reliable: true},
        open,
        close() {
            if (state == 'closed') return
            void port.send({type: 'close', pair, from: self, to: peer})
            teardown('closed')
        },
        state: () => state,
        onFail: {on: cb => failListen.on(cb)},
    }
}

// =====================================================================
// Responder: принимает offer'ы и отдаёт replay-линию во входящий datachannel
// =====================================================================

export type WebRtcAcceptDeps<Z extends any[]> = {
    port: SignalPort
    rtc: () => RtcPeerConnection
    self: string
    /** Что отдавать этой паре: replay-провод (exposeReplay(...) подходит как есть). null = отказ. */
    serve: (env: SignalEnvelope) => ReplayRemote<Z> | null | Promise<ReplayRemote<Z> | null>
    /** Валидация session-материала на приёмной стороне (поверх серверного authorize). */
    accept?: (env: SignalEnvelope) => boolean | Promise<boolean>
}

/**
 * Приёмная сторона direct-маршрута: на offer поднимает peer connection,
 * отвечает answer/ICE через тот же сигнальный порт и обслуживает replay-провод
 * во входящем datachannel. Возвращает close() — снять всё и перестать принимать.
 */
export function acceptWebRtcDirect<Z extends any[] = any[]>(deps: WebRtcAcceptDeps<Z>) {
    const {port, rtc, self, serve, accept} = deps
    type Session = {pc: RtcPeerConnection, stop: (() => void) | null}
    const sessions = new Map<string, Session>() // `${pair}|${from}` — по сессии на инициатора
    let closed = false

    function dropSession(key: string) {
        const s = sessions.get(key)
        if (!s) return
        sessions.delete(key)
        s.stop?.()
        s.pc.close()
    }

    async function onOffer(env: SignalEnvelope) {
        const key = env.pair + '|' + env.from
        if (accept && !(await accept(env))) {
            // отказ приёмной стороны — громко, чтобы инициатор не ждал таймаута
            void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'offer rejected'})
            return
        }
        const source = await serve(env)
        if (!source) {
            void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'nothing to serve'})
            return
        }
        dropSession(key) // повторный offer той же пары = пересоздание сессии
        const pc = rtc()
        const session: Session = {pc, stop: null}
        sessions.set(key, session)
        pc.ondatachannel = function onIncomingChannel(ev) {
            session.stop = serveReplayChannel<Z>(source, channelFromDataChannel(ev.channel))
        }
        pc.onicecandidate = function onIce(ev) {
            if (ev?.candidate != null) {
                const c: any = ev.candidate
                void port.send({type: 'ice', pair: env.pair, from: self, to: env.from, candidate: c?.toJSON ? c.toJSON() : c})
            }
        }
        try {
            await pc.setRemoteDescription({type: 'offer', sdp: env.sdp})
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            void port.send({type: 'answer', pair: env.pair, from: self, to: env.from, sdp: answer.sdp})
        } catch {
            dropSession(key)
            void port.send({type: 'revoke', pair: env.pair, from: self, to: env.from, reason: 'negotiation failed'})
        }
    }

    const offSignals = port.signals.on(function onAcceptSignal(env: SignalEnvelope) {
        if (closed || env == null || env.to != self) return
        if (env.type == 'offer') { void onOffer(env); return }
        const key = env.pair + '|' + env.from
        if (env.type == 'ice' && env.candidate != null) {
            void Promise.resolve(sessions.get(key)?.pc.addIceCandidate(env.candidate)).catch(() => dropSession(key))
            return
        }
        if (env.type == 'close' || env.type == 'revoke') dropSession(key)
    })

    return function closeAccept() {
        if (closed) return
        closed = true
        if (typeof offSignals == 'function') offSignals()
        else (offSignals as any)?.off?.()
        for (const key of Array.from(sessions.keys())) dropSession(key)
    }
}
