import type { CommandCtx } from '../Common/command/command-host';
import type { StoreReplayRemote } from '../Common/Observe/store-replay';
import type { tInputSchema } from './input-schema';
import type { ServiceResourceDefinition } from './resource-definition';
export type tServicePrincipal = {
    account: string;
    roles: readonly string[];
};
export type ServicePermissions = tServicePrincipal & {
    views: string[];
    commands: string[];
    resources?: string[];
};
export declare const SYSTEM_ACCOUNT = "system";
export type ServiceCommandCtx<S> = CommandCtx & {
    state: S;
    roles: readonly string[];
};
export type tServiceCommand<S> = {
    input?: tInputSchema;
    validate?: (input: any) => void;
    apply: (ctx: ServiceCommandCtx<S>, input: any) => unknown;
    allow?: readonly string[];
    limit?: {
        perMinute: number;
    };
};
export type tServiceView<S> = {
    allow: 'public' | readonly string[];
    shared?: boolean;
    keys?: readonly string[];
    project: (state: S, principal: tServicePrincipal | null) => object;
};
export type tServiceDefinition<S extends Record<string, any> = Record<string, any>, Cmds extends Record<string, tServiceCommand<S>> = Record<string, tServiceCommand<S>>> = {
    name: string;
    storeId: string;
    originId: string;
    initial: S;
    commands: Cmds;
    resources?: Record<string, ServiceResourceDefinition>;
    readerFacet?: (state: S) => unknown;
    access?: {
        rolesOf?: (state: S, account: string) => readonly string[];
        login?: {
            input: tInputSchema;
            resolve: (state: S, input: any) => string | null;
        };
        signup?: {
            input: tInputSchema;
            command: string;
        };
    };
    views?: Record<string, tServiceView<S>>;
    version?: number;
    migrate?: (state: any, fromVersion: number) => S;
    limits?: {
        perMinute?: number;
    };
};
export type tDefinitionState<D> = D extends {
    initial: infer S extends Record<string, any>;
} ? S : never;
export type tDefinitionCommands<D> = D extends {
    commands: infer C extends Record<string, tServiceCommand<any>>;
} ? C : never;
export type tHasViews<D> = D extends {
    views: Record<string, any>;
} ? true : false;
export type tHasLogin<D> = D extends {
    access: {
        login: {
            input: any;
        };
    };
} ? true : false;
export type tHasSignup<D> = D extends {
    access: {
        signup: {
            input: any;
        };
    };
} ? true : false;
type tViewLine<V> = V extends {
    project: (...args: any[]) => infer P extends object;
} ? StoreReplayRemote<P> : never;
export type tPublicViewLines<D> = D extends {
    views: infer V extends Record<string, tServiceView<any>>;
} ? {
    [K in keyof V as V[K]['allow'] extends 'public' ? K : never]: tViewLine<V[K]>;
} : {};
export type tPrincipalViewLines<D> = D extends {
    views: infer V extends Record<string, tServiceView<any>>;
} ? {
    [K in keyof V]: tViewLine<V[K]>;
} : {};
type tMinted = {
    token: string;
    account: string;
    expiresAt?: number;
};
export type tIdentityFragment<D, Base extends {
    renew: (...args: any[]) => any;
}> = tHasLogin<D> extends true ? {
    login: (credentials: unknown) => tMinted;
    renew: Base['renew'];
} & (tHasSignup<D> extends true ? {
    signup: (requestId: string, input: unknown) => Promise<unknown>;
} : {}) : Base;
export type tPrincipalFacade<D, C, R> = {
    whoami: () => string;
    me: () => ServicePermissions;
    commands: C;
    permissions: StoreReplayRemote<ServicePermissions>;
} & (R extends () => unknown ? {
    revoke: R;
} : {}) & (tHasViews<D> extends true ? {
    views: tPrincipalViewLines<D>;
} : {});
export {};
