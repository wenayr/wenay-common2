import { Listener } from './Listen';
import { ReplayRemote } from './replay-wire';
import { ReplayRouteSubscribeOpts } from './replay-route';
export type tRouteKind = 'relay' | 'direct';
export type tConnectorState = 'idle' | 'opening' | 'open' | 'closed' | 'failed';
export type RouteConnectorInfo = {
    label: string;
    kind: tRouteKind;
    binary?: boolean;
    ordered?: boolean;
    reliable?: boolean;
};
export type RouteConnectorMetrics = {
    rtt?: number;
    pending?: number;
};
export type RouteConnector<Z extends any[] = any[]> = {
    info: RouteConnectorInfo;
    open: () => Promise<ReplayRemote<Z>> | ReplayRemote<Z>;
    close: () => void;
    state: () => tConnectorState;
    metrics?: () => RouteConnectorMetrics;
    onFail?: {
        on: (cb: (reason?: unknown) => void) => any;
    };
};
export type RoutePairRef = {
    a: string;
    b: string;
    key: string;
};
export type RoutePolicyCtx = RoutePairRef & {
    state: tRouteState;
    reason?: unknown;
};
type tPolicyHook = (ctx: RoutePolicyCtx) => boolean | Promise<boolean>;
export type RoutePolicy = {
    canDirect?: tPolicyHook;
    mustRelay?: tPolicyHook;
    mustShadowRelay?: tPolicyHook;
    canExposeEndpoint?: tPolicyHook;
    canReinterpose?: tPolicyHook;
};
export type tRouteState = 'relay' | 'direct:connecting' | 'direct' | 'direct+shadowRelay' | 'relay:reinterposing' | 'fallback' | 'blocked' | 'closed';
export type RouteChangeEvent = RoutePairRef & {
    from: tRouteState;
    to: tRouteState;
    reason?: unknown;
};
export type RouteOpResult = {
    ok: boolean;
    state: tRouteState;
    reason?: unknown;
};
export type PromoteDirectOpts = {
    timeoutMs?: number;
    reason?: unknown;
};
export type RouteCoordinatorDeps<Z extends any[] = any[]> = {
    policy?: RoutePolicy;
    connect: (ref: RoutePairRef, kind: tRouteKind) => RouteConnector<Z>;
    shadow?: (ref: RoutePairRef, ...ev: Z) => void;
    catchUpTimeoutMs?: number;
};
export declare function createRouteCoordinator<Z extends any[] = any[]>(deps: RouteCoordinatorDeps<Z>): {
    pair(a: string, b: string): {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    };
    state: (pairOrKey: {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    } | RoutePairRef | string) => tRouteState;
    promoteDirect: (pairOrKey: {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    } | RoutePairRef | string, opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
    reinterposeRelay: (pairOrKey: {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    } | RoutePairRef | string, reason?: unknown) => Promise<RouteOpResult>;
    fallback: (pairOrKey: {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    } | RoutePairRef | string, reason?: unknown) => Promise<RouteOpResult>;
    block: (pairOrKey: {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    } | RoutePairRef | string, reason?: unknown) => Promise<RouteOpResult>;
    onRoute: (cb: (ev: RouteChangeEvent) => void) => import("./Listen").ListenOff;
    pairs: () => {
        ref: RoutePairRef;
        state: () => tRouteState;
        reason: () => unknown;
        label: () => string;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: tConnectorState;
            } | null;
        };
        subscribe: (cb: Listener<Z>, opts?: Omit<ReplayRouteSubscribeOpts, 'label'>) => (() => void) & {
            ready: Promise<void>;
            seq: () => number;
            label: () => string | undefined;
            active: () => boolean;
        };
        promoteDirect: (opts?: PromoteDirectOpts) => Promise<RouteOpResult>;
        reinterposeRelay: (reason?: unknown) => Promise<RouteOpResult>;
        fallback: (reason?: unknown) => Promise<RouteOpResult>;
        block: (reason?: unknown) => Promise<RouteOpResult>;
        close: () => void;
    }[];
    close(): void;
};
export type RouteCoordinator<Z extends any[] = any[]> = ReturnType<typeof createRouteCoordinator<Z>>;
export type RouteLink<Z extends any[] = any[]> = ReturnType<RouteCoordinator<Z>['pair']>;
export {};
