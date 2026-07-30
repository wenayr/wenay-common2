import {SocketTmpl} from "./rpc-protocol";
import {createRpcClient, type RpcAuthEvent, type RpcAuthRenewRequest} from "./rpc-client";
import {DeepSocketListen, DeepSocketListenSmart} from "./listen-deep";
import { type RpcOpt } from "./rpc-caps";
import {RPC_TRANSPORT_CONTROL, type TransportLifecycleControl} from '../events/transport-lifecycle'

export interface RpcHubSocket extends SocketTmpl {
    disconnect?: () => void;
}

export type RpcDescriptor<T extends object> = {
    socketKey?: string;
    __type?: T;
};

export function rpc<T extends object>(socketKey?: string): RpcDescriptor<T> {
    return { socketKey };
}

type RpcClientResult<T extends object> = ReturnType<typeof createRpcClient<DeepSocketListenSmart<T>>>;

type TransportClient = {
    initStrict?: () => Promise<void>
    dispose?: (reason?: string, opts?: {socketAlive?: boolean}) => void
    [RPC_TRANSPORT_CONTROL]?: TransportLifecycleControl
}

// ============================================================
// Token provider — the whole token lifecycle behind ONE application function
// ============================================================
// The provider answers "what is the current token"; everything else (soft reauth on the live
// socket, one retry per unauthorized call) is the facade client's mechanism.

/** Application seam: yields the current token, or null when there is none. */
export type RpcTokenProvider = (request: RpcAuthRenewRequest) => string | null | undefined | Promise<string | null | undefined>

/** What hub auth observers receive: the client event plus WHICH facade reported it. */
export type RpcHubAuthEvent = RpcAuthEvent & {key: string}

export function createRpcClientHub<T extends Record<string, RpcDescriptor<any>>, T2 extends RpcHubSocket>(
    createSocket: (token: string | null) => T2,
    schemaBuilder: (helper: typeof rpc) => T,
    hubOpts?: {
        opt?: RpcOpt
        /** One function for the whole token lifecycle: consulted when a connection is
         *  established, when the server pushes an auth state, and on the unauthorized retry.
         *  Giving it also starts the hub — the application never calls connect(). */
        token?: RpcTokenProvider
    },
) {
    const schema = schemaBuilder(rpc);

    type SchemaTypes = {
        [K in keyof T]: T[K] extends RpcDescriptor<infer U extends object>
            ? RpcClientResult<U>
            : never;
    };

    type FacadeClients = { [K in keyof SchemaTypes]: SchemaTypes[K]  };

    type SocketContext = {
        socket: T2
        clients: TransportClient[]
        connected: boolean
        terminal: boolean
        attempt: number
        disconnectNotified: boolean
    }

    const facade = {} as FacadeClients;
    // for (const key in schema) {
    //     facade[key] = null;
    // }

    let socket: RpcHubSocket | null = null;
    let currentToken: string | null = null; // keep for soft reauth on live socket
    let connectCount = 0;
    let onConnectCb: ((count: number) => void) | null = null;
    let onDisconnectCb: ((reason: string) => void) | null = null;
    const connectCbs = new Set<(count: number) => void>()
    const authCbs = new Set<(event: RpcHubAuthEvent) => void>()
    const disconnectCbs = new Set<(reason: string) => void>()
    let activeContext: SocketContext | null = null
    let resolveFunc: ((facade: FacadeClients) => void)|null = null;
    let promise = new Promise<FacadeClients>((resolve) => {
        resolveFunc = resolve;
    })

    function callObserver<T>(cb: (value: T) => void, value: T, errors: any[]) {
        try { cb(value) }
        catch (error) { errors.push(error) }
    }

    function rethrowObserverErrors(errors: any[]) {
        for (const error of errors) {
            setTimeout(function rethrowLifecycleObserverError() { throw error }, 0)
        }
    }

    // ===================================================================
    // Token provider: one call per renewal wave, one precedence rule
    // ===================================================================
    // PRECEDENCE — explicit token vs provider. An explicit token wins for its OWN handshake and
    // for nothing else; "its own" is ONE connection wave, not every wave that follows:
    //   • connect(token) / setToken(token) win for the wave they raise — that wave's 'connect'
    //     renewal answers with the explicit token for EVERY facade client of the wave, and the
    //     provider is not consulted;
    //   • every LATER wave (a transport reconnect on the same socket, a server generation
    //     change) and every renewal trigger ('expiring'/'expired'/'revoked'/'unauthorized') go
    //     to the provider. A token that outlived its wave would be re-presented forever —
    //     including one the server has already revoked, so every reconnect would start refused;
    //   • reauth(token) claims no wave at all: its own handshake is the HELLO it issues itself
    //     on the live socket, so a future connection inherits nothing from it;
    //   • the provider yielding nothing is not a downgrade — the facade client keeps the token
    //     already in force, which for the first wave IS the explicit one.
    const tokenProvider = hubOpts?.token ?? null
    let explicitToken: string | null = null
    // Which wave owns explicitToken: connectCount is bumped once per accepted connection, so the
    // whole wave sees the same answer and the next one cannot.
    let explicitTokenWave = 0
    let tokenInFlight: Promise<string | null> | null = null

    // SINGLE-FLIGHT: N triggers (several facade clients, several calls in flight inside one
    // client) share ONE provider call. The slot is released only after it settles, so the NEXT
    // wave asks again instead of reusing a stale answer.
    function provideToken(request: RpcAuthRenewRequest) {
        if (!tokenProvider) return Promise.resolve(null)
        const running = tokenInFlight
        if (running) return running
        const started = requestToken(request)
        tokenInFlight = started
        function clearTokenInFlight() { if (tokenInFlight == started) tokenInFlight = null }
        // Both settle paths clear the slot, and the rejection is consumed HERE as well:
        // a provider that throws must reach the facade client, not Node's crash handler.
        started.then(clearTokenInFlight, clearTokenInFlight)
        return started
    }

    async function requestToken(request: RpcAuthRenewRequest) {
        const token = await tokenProvider!(request)
        if (token != null) currentToken = token
        return token ?? null
    }

    function renewHubToken(request: RpcAuthRenewRequest) {
        const ownWave = explicitToken != null && explicitTokenWave == connectCount
        if (request.reason == 'connect' && ownWave) return Promise.resolve(explicitToken)
        return provideToken(request)
    }

    function notifyAuthState(event: RpcHubAuthEvent) {
        const errors: any[] = []
        for (const cb of [...authCbs]) callObserver(cb, event, errors)
        rethrowObserverErrors(errors)
    }

    function notifyConnect(count: number) {
        const errors: any[] = []
        const legacy = onConnectCb
        if (legacy) callObserver(legacy, count, errors)
        for (const cb of [...connectCbs]) callObserver(cb, count, errors)
        rethrowObserverErrors(errors)
    }

    function notifyDisconnect(context: SocketContext, reason: string) {
        if (context.disconnectNotified) return
        context.disconnectNotified = true
        const errors: any[] = []
        const legacy = onDisconnectCb
        if (legacy) callObserver(legacy, reason, errors)
        for (const cb of [...disconnectCbs]) callObserver(cb, reason, errors)
        rethrowObserverErrors(errors)
    }

    function closeContext(context: SocketContext, reason: string) {
        if (context.terminal) return
        // Mark the hard boundary before Socket.IO emits its own disconnect. The native
        // handler therefore cannot turn token rotation into a second logical notification.
        context.terminal = true
        context.connected = false
        context.attempt++
        for (const client of context.clients) client[RPC_TRANSPORT_CONTROL]?.close(reason)
        for (const client of context.clients) client.dispose?.(reason, {socketAlive: false})
        context.socket.disconnect?.()
        notifyDisconnect(context, reason)
    }

    async function handshakeAndConnect(context: SocketContext, attempt: number, count: number) {
        await Promise.all(context.clients.map(function initClient(client) {
            return client.initStrict?.()
        }))
        if (activeContext != context || context.terminal || !context.connected || context.attempt != attempt) return
        for (const client of context.clients) client[RPC_TRANSPORT_CONTROL]?.connect()
        if (activeContext != context || context.terminal || !context.connected || context.attempt != attempt) return
        notifyConnect(count)
        if (activeContext != context || context.terminal || !context.connected || context.attempt != attempt) return
        if (resolveFunc) {
            const resolve = resolveFunc
            resolveFunc = null
            resolve(facade)
        }
    }

    function setToken(token: string | null) {
        explicitToken = token
        // The wave this call raises is the next connection accepted on the new socket.
        explicitTokenWave = connectCount + 1
        if (activeContext) closeContext(activeContext, 'token rotated')
        // previous promise may have resolved — awaiters of NEW connection need fresh
        if (!resolveFunc) promise = new Promise<FacadeClients>((resolve) => { resolveFunc = resolve; });
        currentToken = token;
        const nextSocket = createSocket(token)
        socket = nextSocket
        const clients: TransportClient[] = []

        for (const key in schema) {
            const targetSocketKey = schema[key].socketKey || key;
            // token → client will present it via Pkt.HELLO in initStrict() on connect.
            const client = createRpcClient<any>({ socketKey: targetSocketKey, socket: nextSocket, token, opt: hubOpts?.opt });
            const transportClient = client as TransportClient
            // A direct client is online by default for back-compat. Hub ownership is different:
            // no RPC packet may leave before this socket generation completes its handshake.
            transportClient[RPC_TRANSPORT_CONTROL]?.disconnect('RPC hub awaiting handshake')
            // The provider is the hub's policy; soft reauth on the live socket and the single
            // unauthorized retry are the client's mechanism. Observers are relayed even without
            // a provider — expiry is worth reporting to an application that renews by hand.
            if (tokenProvider) client.setTokenRenew(renewHubToken)
            client.onAuthState(function relayAuthState(event) { notifyAuthState({...event, key}) })
            facade[key] = client as FacadeClients[typeof key];
            clients.push(transportClient)
        }

        const context: SocketContext = {
            socket: nextSocket,
            clients,
            connected: false,
            terminal: false,
            attempt: 0,
            disconnectNotified: false,
        }
        activeContext = context

        nextSocket.on('connect', function onSocketConnect() {
            if (activeContext != context || context.terminal) return
            context.connected = true
            context.disconnectNotified = false
            const attempt = ++context.attempt
            const count = ++connectCount
            // initStrict installs the new connection's route/auth map. Physical Listen
            // recovery starts only after that handshake and is guarded against a later flap.
            handshakeAndConnect(context, attempt, count).catch(function reportHandshakeError(error) {
                if (activeContext != context || context.terminal || context.attempt != attempt) return
                setTimeout(function rethrowHandshakeError() { throw error }, 0)
            })
        })
        nextSocket.on('disconnect', function onSocketDisconnect(reason: any) {
            if (activeContext != context || context.terminal || !context.connected) return
            context.connected = false
            context.attempt++
            const disconnectReason = typeof reason == 'string' ? reason : String(reason ?? 'socket disconnected')
            for (const client of context.clients) client[RPC_TRANSPORT_CONTROL]?.disconnect(disconnectReason)
            notifyDisconnect(context, disconnectReason)
        })
        return promise
    }

    // Soft re-auth on LIVE socket (NO disconnect/rotation — that's setToken job):
    // present new token to each facade client via Pkt.HELLO; subscriptions preserved.
    function reauth(token: string | null) {
        // No wave is claimed here (see PRECEDENCE): this token's own handshake is the HELLO each
        // facade client issues below on the LIVE socket. Pinning it would make every later
        // connection present it again, long after the server stopped accepting it.
        currentToken = token;
        const ps: Promise<any>[] = [];
        for (const key in schema) {
            const client = facade[key] as { reauth?: (t: any) => Promise<any> } | undefined;
            if (client && typeof client.reauth === "function") ps.push(client.reauth(token));
        }
        return Promise.all(ps);
    }

    function connectListen(cb: (count: number) => void) {
        connectCbs.add(cb)
        return function offConnect() { connectCbs.delete(cb) }
    }

    function authListen(cb: (event: RpcHubAuthEvent) => void) {
        authCbs.add(cb)
        return function offAuth() { authCbs.delete(cb) }
    }

    function disconnectListen(cb: (reason: string) => void) {
        disconnectCbs.add(cb)
        return function offDisconnect() { disconnectCbs.delete(cb) }
    }

    const result = {
        get promise() { return promise; },
        facade,
        /** @deprecated Use {@link connect} — same hard (re)connection by token. */
        setToken,
        /** Hard (re)connection by token: breaks former socket, drains facade, raises
         *  new socket and reinitializes clients. connect(null) — anonymous. Paired with onConnect
         *  (soft principal change — {@link reauth}). Delegates to setToken. */
        connect: setToken,
        /** Soft re-auth: changes principal on live socket, doesn't break subscriptions (vs hard setToken). */
        reauth,
        get socket() { return socket as T2; },
        onConnect: (func?: ((count: number) => void) | null) => { onConnectCb = func ?? null; },
        /** Legacy single-slot observer for transient disconnect and hard token rotation. */
        onDisconnect: (func?: ((reason: string) => void) | null) => { onDisconnectCb = func ?? null; },
        /** Additive connect observers; each returned off removes only its own listener. */
        connectListen,
        /** Additive disconnect observers, independent from the legacy onDisconnect slot. */
        disconnectListen,
        /** Additive auth observers: server states (expiring/expired/revoked) of every facade
         *  plus the local outcome of an automatic renewal — 'renewed' (with the new deadline
         *  when the server sent one) or 'renewFailed' when the provider yields nothing. */
        authListen,
        connectCount: () => connectCount,
    };

    // A token provider owns the whole lifecycle, so the hub raises its own socket: the
    // application writes one function and never calls connect(). An explicit connect(token)
    // afterwards is still a normal hard rotation and takes precedence for the wave it raises.
    if (tokenProvider) setToken(null)

    return result;
}
