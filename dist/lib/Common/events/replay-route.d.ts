import { Listener } from './Listen';
import { ReplayRemote, ReplaySubscribeOpts } from './replay-wire';
export type ReplayRoutePhase = 'switching' | 'ready' | 'error' | 'closed';
export type ReplayRouteEvent = {
    phase: ReplayRoutePhase;
    seq: number;
    from?: string;
    to?: string;
    error?: unknown;
};
export type ReplayRouteSwitchOpts = Pick<ReplaySubscribeOpts, 'policy' | 'hint'> & {
    label?: string;
    since?: number;
    reset?: boolean;
};
export type ReplayRouteSubscribeOpts = ReplayRouteSwitchOpts & Pick<ReplaySubscribeOpts, 'onSeq' | 'onError'> & {
    onRoute?: (ev: ReplayRouteEvent) => void;
};
export declare function replayRouteSubscribe<Z extends any[]>(remote: ReplayRemote<Z>, cb: Listener<Z>, opts?: ReplayRouteSubscribeOpts): (() => void) & {
    ready: Promise<void>;
    switch: (nextRemote: ReplayRemote<Z>, nextOpts?: ReplayRouteSwitchOpts) => Promise<void>;
    seq: () => number;
    label: () => string | undefined;
    active: () => boolean;
};
