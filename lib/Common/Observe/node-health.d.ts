import { StoreDrain } from './store';
export type NodeHealthState = {
    node: string;
    startedTs: number;
    refreshedTs: number;
    parts: Record<string, unknown>;
};
export type NodeHealthDeps = {
    node: string;
    intervalMs?: number;
    now?: () => number;
    drain?: StoreDrain;
};
export declare function createNodeHealth(deps: NodeHealthDeps): {
    store: import("./store").Store<NodeHealthState>;
    register: (name: string, probe: () => unknown) => () => void;
    refresh: (name?: string) => NodeHealthState;
    close(): void;
};
export type NodeHealth = ReturnType<typeof createNodeHealth>;
