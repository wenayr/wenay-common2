import { type StoreNodeDeps, type StoreNodePrincipal } from '../Common/Observe/store-node';
import { type tServiceDefinition } from './definition';
export type ServiceNodeDeps<S extends Record<string, any>> = {
    definition: tServiceDefinition<S>;
    nodeId: string;
    verifyToken: (presented: unknown) => StoreNodePrincipal;
    upstream: StoreNodeDeps<S>['upstream'];
    serve: Pick<StoreNodeDeps<S>['serve'], 'onConnection'>;
    selfUrl: () => string;
    onLeave: (reason: string) => void;
    heartbeatMs?: number;
    graceMs?: number;
    log?: (line: string) => void;
};
export declare function createServiceNode<S extends Record<string, any>>(deps: ServiceNodeDeps<S>): {
    start: () => Promise<void>;
    leave: (reason: string) => void;
    view: {
        nodeId: string;
        status: () => {
            started: boolean;
            leaving: boolean;
            rehomes: number;
            readers: number;
            seq: number | undefined;
        };
    };
    close(): void;
};
