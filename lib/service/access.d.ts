import type { Store } from '../Common/Observe/store';
import type { StoreNodePrincipal, StoreNodeSession } from '../Common/Observe/store-node';
import type { tDefinitionState, tPrincipalFacade, tPublicViewLines, tServiceDefinition, tServicePrincipal } from './definition';
export type ServiceAccessDeps<D extends tServiceDefinition<any, any>> = {
    definition: D;
    store: Store<tDefinitionState<D>>;
};
export declare function createServiceAccess<D extends tServiceDefinition<any, any>>(deps: ServiceAccessDeps<D>): {
    principalOf: (who: Pick<StoreNodePrincipal, 'account'>) => tServicePrincipal;
    rights: (principal: tServicePrincipal | null) => {
        views: string[];
        commands: string[];
        resources?: string[] | undefined;
    };
    publicViews: () => tPublicViewLines<D> | null;
    snapshot: (name: string, principal: tServicePrincipal | null) => object;
    principal: <C extends Record<string, unknown>, R extends (() => unknown) | undefined = undefined>(who: StoreNodePrincipal, defaults: {
        whoami: () => string;
        commands?: C;
        revoke?: R;
    }, session: StoreNodeSession) => tPrincipalFacade<D, C, R>;
    close: () => void;
};
export type ServiceAccess<D extends tServiceDefinition<any, any> = tServiceDefinition<any, any>> = ReturnType<typeof createServiceAccess<D>>;
