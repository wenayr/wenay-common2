import type { RpcClientReturn } from '../Common/rcp/rpc-client';
import type { DeepSocketListenSmart } from '../Common/rcp/listen-deep';
import type { tServiceDefinition } from './definition';
import type { ServiceClientDefinition } from './descriptor';
import type { ServiceResourceDefinition, ServiceResourceOptions, ServiceResourceStatus } from './resource-definition';
type tResources<D> = D extends {
    resources: infer R extends Record<string, ServiceResourceDefinition>;
} ? R : {};
type tFacade<R> = R extends {
    open: (...args: any[]) => infer T;
} ? Awaited<T> extends {
    facade: infer F extends object;
} ? F : never : never;
type tRemote<F extends object> = RpcClientReturn<DeepSocketListenSmart<F>>['func'];
declare function createResourceController<F extends object>(deps: {
    name: string;
    supported: boolean;
    url: string;
    options?: ServiceResourceOptions;
    token: (renew: boolean) => Promise<string | null>;
    tokens: (callback: (token: string) => void) => () => void;
    released: () => void;
}): {
    status: import("../Common/Observe").Store<ServiceResourceStatus>;
    current: () => {
        generation: number;
        remote: tRemote<F>;
    } | null;
    close: () => Promise<void>;
};
export type ServiceResourceController<F extends object> = ReturnType<typeof createResourceController<F>>;
export declare function createServiceResources<D extends tServiceDefinition<any, any>>(deps: {
    definition: D | ServiceClientDefinition<D>;
    url: string;
    options?: ServiceResourceOptions;
    token: (renew: boolean) => Promise<string | null>;
    tokens: (callback: (token: string) => void) => () => void;
}): {
    resource: {
        open: <K extends keyof tResources<D> & string>(name: K) => {
            status: import("../Common/Observe").Store<ServiceResourceStatus>;
            current: () => {
                generation: number;
                remote: import("..").ClientAPIAll<DeepSocketListenSmart<tFacade<tResources<D>[K]>>>;
            } | null;
            close: () => Promise<void>;
        };
    };
    close: () => void;
};
export {};
