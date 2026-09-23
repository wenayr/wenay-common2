import { type RpcHubAuthEvent } from '../Common/rcp/rpc-clientHub';
import { type NodeDirectoryView } from '../Common/Observe/node-directory';
import { type Store } from '../Common/Observe/store';
export type { ServiceResourceController } from './resource-client';
import type { ServiceResourceOptions } from './resource-definition';
import type { ServiceClientDefinition } from './descriptor';
export { describeService, type ServiceClientDefinition } from './descriptor';
import type { ServicePermissions, tServiceCommand, tServiceDefinition, tServiceView } from './definition';
export type tServiceAuth = {
    token: string;
} | {
    credentials: unknown;
} | {
    login: () => Promise<string>;
};
export type ServiceClientDeps<D extends tServiceDefinition<any, any>> = {
    definition: D | ServiceClientDefinition<D>;
    url: string;
    auth?: tServiceAuth;
    onToken?: (token: string) => void;
    placement?: {
        prefer?: 'nodes' | 'any';
        rng?: () => number;
    };
    clientId?: string;
    handshake?: Record<string, unknown>;
    log?: (line: string) => void;
    resourceOptions?: ServiceResourceOptions;
};
type tViewsOf<D> = D extends {
    views: infer V extends Record<string, tServiceView<any>>;
} ? V : {};
type tProjectionOf<V> = V extends {
    project: (...args: any[]) => infer P extends object;
} ? P : never;
type tCommandsOf<D> = D extends {
    commands: infer C extends Record<string, tServiceCommand<any>>;
} ? C : {};
export type tClientCommands<D> = tCommandsOf<D> extends infer C extends Record<string, tServiceCommand<any>> ? {
    [K in keyof C & string]: (requestId: string, input: Parameters<C[K]['apply']>[1]) => Promise<Awaited<ReturnType<C[K]['apply']>>>;
} : {};
export type tClientViews<D> = {
    [K in keyof tViewsOf<D> & string]: ServiceClientView<tProjectionOf<tViewsOf<D>[K]>>;
};
export type ServiceClientView<P extends object> = {
    store: Store<P>;
    ready: Promise<void>;
    seq: () => number;
    close: () => void;
};
export declare function createServiceClient<D extends tServiceDefinition<any, any>>(deps: ServiceClientDeps<D>): {
    ready: () => Promise<undefined>;
    identity: {
        account: () => string | null;
        token: () => string | null;
        me: () => Promise<ServicePermissions>;
        permissions: Store<{
            account: string | null;
            roles: readonly string[];
            views: string[];
            commands: string[];
            resources?: string[];
        }>;
        onToken: {
            on: import("..").ListenOn<[string]>;
        };
        onAuth: {
            on: import("..").ListenOn<[RpcHubAuthEvent]>;
        };
    };
    health: Store<{
        connected: boolean;
        nodeId: string;
        url: string;
    }>;
    views: tClientViews<D>;
    commands: tClientCommands<D>;
    resources: {
        open: <K extends keyof (D extends {
            resources: infer R extends Record<string, import("./resource-definition").ServiceResourceDefinition>;
        } ? R : {}) & string>(name: K) => {
            status: Store<import("./resource-definition").ServiceResourceStatus>;
            current: () => {
                generation: number;
                remote: import("..").ClientAPIAll<import("..").DeepSocketListenSmart<(D extends {
                    resources: infer R extends Record<string, import("./resource-definition").ServiceResourceDefinition>;
                } ? R : {})[K] extends infer T ? T extends (D extends {
                    resources: infer R extends Record<string, import("./resource-definition").ServiceResourceDefinition>;
                } ? R : {})[K] ? T extends {
                    open: (...args: any[]) => infer T_1;
                } ? Awaited<T_1> extends {
                    facade: infer F extends object;
                } ? F : never : never : never : never>>;
            } | null;
            close: () => Promise<void>;
        };
    };
    view: {
        endpoint: () => NodeDirectoryView | null;
        roster: () => NodeDirectoryView[];
    };
    control: {
        repick(): void;
    };
    close: () => void;
};
export type ServiceClient<D extends tServiceDefinition<any, any> = tServiceDefinition<any, any>> = ReturnType<typeof createServiceClient<D>>;
