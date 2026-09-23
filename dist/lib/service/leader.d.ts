import type { CommandCtx } from '../Common/command/command-host';
import type { ScaleDurableLine } from '../Common/scale/scale-authority';
import { type ServiceResourceDiagnostic } from './resource-session';
import type { ServiceResourceOptions } from './resource-definition';
import type { RpcServerControl } from '../Common/rcp/rpc-server';
import { type tServiceDefinition, type tDefinitionState, type tDefinitionCommands, type tServiceCommand, type tIdentityFragment, type tHasViews, type tPublicViewLines } from './definition';
type tDomainCommandMap<Cmds extends Record<string, tServiceCommand<any>>> = {
    [K in keyof Cmds & string]: (ctx: CommandCtx, input: Parameters<Cmds[K]['apply']>[1]) => ReturnType<Cmds[K]['apply']>;
};
type tLegacyView<D> = D extends {
    readerFacet: (state: any) => infer R;
} ? {
    view: () => R;
} : {};
export type ServiceLeaderDeps<D extends tServiceDefinition<any, any>> = {
    definition: D;
    selfUrl: () => string;
    secrets?: {
        nodeToken?: string;
        tokenSecret?: string;
    };
    durable?: ScaleDurableLine;
    durableControl?: ScaleDurableLine;
    log?: (line: string) => void;
    resourceOptions?: ServiceResourceOptions;
};
export declare function createServiceLeader<D extends tServiceDefinition<any, any>>(deps: ServiceLeaderDeps<D>): {
    secrets: {
        nodeToken: string;
        tokenSecret: string;
    };
    line: {
        control: {
            store: import("../Common/Observe").Store<tDefinitionState<D>>;
            addOffer: (offerValue: import("../Common/Observe").StoreReplicaOffer<tDefinitionState<D>>) => () => void;
            removeOffer: (id: string) => boolean;
            setOffers: (next: readonly import("../Common/Observe").StoreReplicaOffer<tDefinitionState<D>>[]) => void;
            probe: () => Promise<void>;
            reconcile: (reason?: string) => Promise<void>;
            promote: (reason?: string) => Promise<import("../Common/Observe").StoreReplicaDescriptor | null>;
            canWrite: () => boolean;
            close: () => void;
        };
        api: {
            store: import("../Common/Observe").Store<tDefinitionState<D>>;
            status: import("../Common/Observe").Store<import("../Common/Observe").StoreReplicaSetStatus>;
            ready: Promise<void>;
            descriptor: () => import("../Common/Observe").StoreReplicaDescriptor;
            changed: import("..").ListenApi<[import("../Common/Observe").StoreReplicaDescriptor]>;
            conflicts: import("..").ListenApi<[import("../Common/Observe").StoreReplicaConflict<tDefinitionState<D>>]>;
            routes: import("..").ListenApi<[import("../Common/Observe").StoreReplicaRouteEvent]>;
            replay: {
                has(key: import("..").ListenKey): boolean;
                off(keyOrCallback: import("..").Listener<[readonly import("../Common/Observe").StorePatch[]]> | import("..").ListenKey | null): void;
                count(): number;
                keys(): import("..").ListenKey[];
                isRunning(): boolean;
                run(): void;
                onClose(cb: () => void): import("..").ListenOff;
                emit: import("..").Listener<[readonly import("../Common/Observe").StorePatch[]]>;
                emitBatch: (events: readonly [readonly import("../Common/Observe").StorePatch[]][]) => void;
                head: () => number;
                isStale: () => boolean;
                lastTs: () => number;
                close: () => void;
                journalWindow: () => {
                    entries: number;
                    oldestSeq: number | null;
                    head: number;
                    ageMs: number;
                    bytes: number;
                    historyLimit: number;
                    keepMs: number;
                    keepBytes: number;
                    cappedByCount: boolean;
                    cappedByBytes: boolean;
                };
                line: import("..").ListenApi<[import("../Common/events/replay-listen").ReplayEvent<[readonly import("../Common/Observe").StorePatch[]]>]>;
                hasKeyframe: boolean;
                on: import("../Common/events/replay-listen").ListenOnReplay<[readonly import("../Common/Observe").StorePatch[]]>;
                once: (cb: import("..").Listener<[readonly import("../Common/Observe").StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("..").ListenCurrent<[readonly import("../Common/Observe").StorePatch[]]> | undefined;
                }) => () => void;
                getSince(seq: number): import("../Common/events/replay-listen").ReplayEvent<[readonly import("../Common/Observe").StorePatch[]]>[] | undefined;
                keyframe(): import("../Common/events/replay-listen").ReplayEvent<[readonly import("../Common/Observe").StorePatch[]]> | undefined;
                frame(seq: number, hint?: unknown): import("../Common/events/replay-listen").ReplayEvent<[readonly import("../Common/Observe").StorePatch[]]>[];
            };
            fragment: {
                descriptor: () => import("../Common/Observe").StoreReplicaDescriptor;
                changed: import("..").ListenApi<[import("../Common/Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Common/Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Common/Observe").StoreReplayLineLocal;
                })) & import("../Common/Observe").StoreReplayState<tDefinitionState<D>>;
                ping: () => number;
            };
            canWrite: () => boolean;
        };
    };
    roster: {
        control: {
            set: (row: import("../Common/Observe").NodeDirectoryRow) => void;
            patch: (id: string, partial: Parameters<import("../Common/Observe").NodeDirectory['control']['patch']>[1]) => boolean;
            heartbeat: (id: string, partial?: Parameters<import("../Common/Observe").NodeDirectory['control']['heartbeat']>[1]) => boolean;
            drain: (id: string) => boolean;
            undrain: (id: string, w?: number) => boolean;
            remove: (id: string) => void;
            get: (id: string) => import("../Common/Observe").NodeDirectoryEntry;
            snapshot: () => Record<string, import("../Common/Observe").NodeDirectoryEntry>;
        };
        readonly api: import("../Common/Observe").StoreReplayRemote;
    };
    identity: {
        login: (account: string) => {
            token: string;
            account: string;
            expiresAt?: number | undefined;
        };
        renew: (presented: unknown) => {
            token: string;
            account: string;
            expiresAt?: number | undefined;
        };
        revoke: (account: string) => {
            revoked: true;
            account: string;
            sessionsCut: number;
        };
        mint: (account: string) => {
            token: string;
            account: string;
            expiresAt?: number | undefined;
        };
        principal: (presented: unknown) => import("../Common/Observe").StoreNodePrincipal;
    };
    corridor: {
        execute: <K extends (keyof tDefinitionCommands<D> & string) & string>(account: string, command: K, requestId: string, input: Parameters<tDomainCommandMap<tDefinitionCommands<D>>[K]>[1]) => Promise<Awaited<ReturnType<tDomainCommandMap<tDefinitionCommands<D>>[K]>>>;
        names: (keyof tDefinitionCommands<D> & string)[];
        fragment: (account: string) => import("../Common/command/command-host").CommandFragment<tDomainCommandMap<tDefinitionCommands<D>>>;
        byToken: () => import("../Common/command/command-token").CommandTokenFragment<tDomainCommandMap<tDefinitionCommands<D>>>;
        system: import("../Common/command/command-host").CommandFragment<tDomainCommandMap<tDefinitionCommands<D>>>;
    };
    access: {
        principalOf: (who: Pick<import("../Common/Observe").StoreNodePrincipal, 'account'>) => import("./definition").tServicePrincipal;
        rights: (principal: import("./definition").tServicePrincipal | null) => {
            views: string[];
            commands: string[];
            resources?: string[] | undefined;
        };
        publicViews: () => tPublicViewLines<D> | null;
        snapshot: (name: string, principal: import("./definition").tServicePrincipal | null) => object;
        principal: <C extends Record<string, unknown>, R extends (() => unknown) | undefined = undefined>(who: import("../Common/Observe").StoreNodePrincipal, defaults: {
            whoami: () => string;
            commands?: C | undefined;
            revoke?: R | undefined;
        }, session: import("../Common/Observe").StoreNodeSession) => import("./definition").tPrincipalFacade<D, C, R>;
        close: () => void;
    };
    resources: {
        errors: import("..").ListenApi<[ServiceResourceDiagnostic]>;
    };
    control: {
        start: () => void;
        drain: (nodeId: string) => {
            ok: boolean;
        };
        revoke: (account: string) => {
            revoked: true;
            account: string;
            sessionsCut: number;
        };
        close(): Promise<void>;
    };
    serve: {
        browserFragment: (account: string) => (tHasViews<D> extends true ? {
            roster: import("../Common/Observe").StoreReplayRemote;
            identity: tIdentityFragment<D, {
                login: () => {
                    token: string;
                    account: string;
                    expiresAt?: number | undefined;
                };
                renew: (presented: unknown) => {
                    token: string;
                    account: string;
                    expiresAt?: number | undefined;
                };
            }>;
            views: tPublicViewLines<D>;
        } : Omit<{
            replica: {
                descriptor: () => import("../Common/Observe").StoreReplicaDescriptor;
                changed: import("..").ListenApi<[import("../Common/Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Common/Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Common/Observe").StoreReplayLineLocal;
                })) & import("../Common/Observe").StoreReplayState<tDefinitionState<D>>;
                ping: () => number;
            };
            roster: import("../Common/Observe").StoreReplayRemote;
            identity: {
                login: () => {
                    token: string;
                    account: string;
                    expiresAt?: number | undefined;
                };
                renew: (presented: unknown) => {
                    token: string;
                    account: string;
                    expiresAt?: number | undefined;
                };
            };
        }, "identity"> & {
            identity: tIdentityFragment<D, {
                login: () => {
                    token: string;
                    account: string;
                    expiresAt?: number | undefined;
                };
                renew: (presented: unknown) => {
                    token: string;
                    account: string;
                    expiresAt?: number | undefined;
                };
            }>;
        }) & tLegacyView<D>;
        readFragment: () => (tHasViews<D> extends true ? {
            views: tPublicViewLines<D>;
        } : {
            replica: {
                descriptor: () => import("../Common/Observe").StoreReplicaDescriptor;
                changed: import("..").ListenApi<[import("../Common/Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Common/Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Common/Observe").StoreReplayLineLocal;
                })) & import("../Common/Observe").StoreReplayState<tDefinitionState<D>>;
                ping: () => number;
            };
            node: () => string;
        }) & tLegacyView<D>;
        scaleConnection: () => import("../Common/scale/scale-authority").AuthorityConnection<import("./definition").tPrincipalFacade<D, import("../Common/command/command-host").CommandFragment<tDomainCommandMap<tDefinitionCommands<D>>>, () => {
            revoked: true;
            account: string;
            sessionsCut: number;
        }>>;
        resourceConnection: () => {
            object: {};
            auth: {
                gate: true;
                resolveAuth: (presented: unknown) => {
                    object: {
                        control: {
                            open: (name: string) => {
                                id: `${string}-${string}-${string}-${string}-${string}`;
                            };
                            ready(id: string): Promise<void>;
                            close(id: string): Promise<void>;
                            state: () => import("./resource-definition").ServiceResourceFacts;
                        };
                        events: import("..").ListenApi<[import("./resource-definition").ServiceResourceFacts]>;
                        instances: Record<string, object>;
                    };
                    ack: {
                        ok: boolean;
                        who: string;
                        node: string;
                    };
                    expiresAt?: number;
                    renewBeforeMs: number;
                };
            };
            hooks: {
                onDispose(): void;
            };
            attach: (control: RpcServerControl) => void;
            close: () => Promise<void>;
        };
        nodeLinkFragment: (linkNodeId?: string) => {
            replica: {
                descriptor: () => import("../Common/Observe").StoreReplicaDescriptor;
                changed: import("..").ListenApi<[import("../Common/Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Common/Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Common/Observe").StoreReplayChunksBegin<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Common/Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Common/Observe").StoreReplayLineLocal;
                })) & import("../Common/Observe").StoreReplayState<tDefinitionState<D>>;
                ping: () => number;
            };
            control: import("../Common/Observe").StoreReplayRemote;
            commandsByToken: import("../Common/command/command-token").CommandTokenFragment<tDomainCommandMap<tDefinitionCommands<D>>>;
            register(entry: {
                nodeId?: unknown;
                url?: unknown;
                weight?: unknown;
                role?: unknown;
                pid?: unknown;
                readers?: unknown;
            }): {
                ok: boolean;
            };
            heartbeat(id: unknown, facts?: {
                readers?: unknown;
            } | undefined): {
                ok: boolean;
            };
            goodbye(id: unknown): {
                ok: boolean;
            };
        };
        login: (credentials: unknown) => {
            token: string;
            account: string;
            expiresAt?: number | undefined;
        };
        signup: (requestId: string, input: unknown) => Promise<Awaited<ReturnType<tDomainCommandMap<tDefinitionCommands<D>>[string]>>>;
    };
    view: {
        role: () => import("../Common/scale/scale-authority").tScaleAuthorityRole;
        leaderId: () => string | null;
        epoch: () => number;
        nodes: () => import("../Common/Observe").NodeDirectoryView[];
        readers: () => number;
        isRevoked: (account: string) => boolean;
        restored: () => {
            seq: number;
            fromArchive: boolean;
            control?: {
                seq: number;
                fromArchive: boolean;
            } | undefined;
        } | null;
        archive: () => {
            events: number;
            keyframes: number;
        } | null;
        commandNames: (keyof tDefinitionCommands<D> & string)[];
        state: () => tDefinitionState<D>;
        reader: () => unknown;
    };
};
export type ServiceLeader<D extends tServiceDefinition<any, any> = tServiceDefinition<any, any>> = ReturnType<typeof createServiceLeader<D>>;
export {};
