import { RouteCoordinatorDeps, RoutePolicy, tRouteState } from '../events/route-coordinator';
export type tMediaRouteMode = 'relay' | 'direct' | 'best';
export type tMediaActiveRoute = 'relay' | 'direct' | null;
export type tMediaRouteState = 'idle' | 'starting' | tRouteState;
export type MediaRouteStatus = {
    mode: tMediaRouteMode;
    state: tMediaRouteState;
    active: tMediaActiveRoute;
    label: string | null;
    error?: unknown;
};
export type MediaRouteChange = {
    previous: MediaRouteStatus;
    current: MediaRouteStatus;
    reason?: unknown;
};
export type MediaRouteDeps<Z extends any[] = any[]> = {
    self: string;
    peer: string;
    mode?: tMediaRouteMode;
    connect: RouteCoordinatorDeps<Z>['connect'];
    policy?: RoutePolicy;
    shadow?: RouteCoordinatorDeps<Z>['shadow'];
    catchUpTimeoutMs?: number;
    directRetryMs?: number | false;
};
export declare function createMediaRoute<Z extends any[] = any[]>(deps: MediaRouteDeps<Z>): {
    control: {
        start: () => Promise<MediaRouteStatus>;
        setMode: (next: tMediaRouteMode) => Promise<MediaRouteStatus>;
        reconsider: (reason?: unknown) => Promise<MediaRouteStatus>;
        close: () => void;
    };
    resource: {
        line: import("../..").ListenApi<Z>;
    };
    events: {
        changed: import("../..").ListenApi<[MediaRouteChange]>;
    };
    view: {
        status: () => MediaRouteStatus;
        mode: () => tMediaRouteMode;
        route: () => tMediaActiveRoute;
        metrics: () => {
            relay: {
                rtt?: number;
                pending?: number;
                state: import("../events/route-coordinator").tConnectorState;
            } | null;
            direct: {
                rtt?: number;
                pending?: number;
                state: import("../events/route-coordinator").tConnectorState;
            } | null;
        };
    };
};
export type MediaRoute<Z extends any[] = any[]> = ReturnType<typeof createMediaRoute<Z>>;
