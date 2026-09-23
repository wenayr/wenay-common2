import type { StoreNodePrincipal } from '../Common/Observe/store-node';
import type { tServicePrincipal } from './definition';
import type { ServiceResourceDefinition, ServiceResourceFacts, ServiceResourceOptions } from './resource-definition';
export type ServiceResourceDiagnostic = {
    name: string;
    resourceId: string;
    phase: 'open' | 'close';
    error: unknown;
};
export declare function createResourceSession(deps: {
    registry: Record<string, ServiceResourceDefinition>;
    principalOf: (who: StoreNodePrincipal) => tServicePrincipal;
    changes: (callback: () => void) => () => void;
    report: (diagnostic: ServiceResourceDiagnostic) => void;
    options?: ServiceResourceOptions;
}): {
    update: (principal: StoreNodePrincipal) => {
        control: {
            open: (name: string) => {
                id: `${string}-${string}-${string}-${string}-${string}`;
            };
            ready(id: string): Promise<void>;
            close(id: string): Promise<void>;
            state: () => ServiceResourceFacts;
        };
        events: import("..").ListenApi<[ServiceResourceFacts]>;
        instances: Record<string, object>;
    };
    suspend: () => void;
    close: () => Promise<void>;
    hooks: {};
    facade: {
        control: {
            open: (name: string) => {
                id: `${string}-${string}-${string}-${string}-${string}`;
            };
            ready(id: string): Promise<void>;
            close(id: string): Promise<void>;
            state: () => ServiceResourceFacts;
        };
        events: import("..").ListenApi<[ServiceResourceFacts]>;
        instances: Record<string, object>;
    };
    sessionId: `${string}-${string}-${string}-${string}-${string}`;
};
export type ResourceSession = ReturnType<typeof createResourceSession>;
