import type { RpcServerControl } from '../rcp/rpc-server';
import { type CommandFragment, type CommandHostDeps, type tCommandMap } from '../command/command-host';
import { type NodeDirectory, type NodeDirectoryRow } from '../Observe/node-directory';
import { type DurableStoreDeps } from '../Observe/store-durable';
import type { StoreReplayRemote } from '../Observe/store-replay';
import { type StoreLineCoordinates, type StoreReplicaLeadership, type StoreReplicaSession } from '../Observe/store-replica-set';
import type { StoreNodePrincipal, StoreNodeSession } from '../Observe/store-node';
import type { Store } from '../Observe/store';
export type ScaleIdentityAdapter = {
    issue: (account: string) => string;
    verify: (presented: unknown) => StoreNodePrincipal;
    renewBeforeMs?: number;
};
export type AuthorityPrincipalDefaults<T extends Record<string, any>, Cmds extends tCommandMap> = {
    whoami: () => string;
    commands: CommandFragment<Cmds>;
    revoke: () => {
        revoked: true;
        account: string;
        sessionsCut: number;
    };
    store: Store<T>;
};
export type AuthorityPrincipalFacade<T extends Record<string, any>, Cmds extends tCommandMap> = Omit<AuthorityPrincipalDefaults<T, Cmds>, 'store'>;
export type AuthorityPrincipalShaper<T extends Record<string, any>, Cmds extends tCommandMap, F extends Record<string, unknown> = Record<string, unknown>> = (principal: StoreNodePrincipal, defaults: AuthorityPrincipalDefaults<T, Cmds>, session: StoreNodeSession) => F;
export type AuthorityConnection<F extends Record<string, unknown>> = {
    object: {};
    auth: {
        gate: true;
        resolveAuth: (presented: unknown) => {
            object: F;
            ack: {
                ok: boolean;
                who: string;
                node: string;
            };
            expiresAt?: number;
            renewBeforeMs: number;
        };
    };
    attach: (attached: RpcServerControl) => void;
    close: () => void;
};
export type tScaleAuthorityRole = 'leader' | 'standby';
export type AuthorityUpstream = {
    replica: StoreReplicaSession['remote'];
    control: StoreReplayRemote;
    register: (entry: {
        nodeId: string;
        url: string;
        weight: number;
        role?: 'mirror' | 'standby';
        pid?: number;
    }) => unknown;
    heartbeat: (nodeId: string, facts?: Record<string, unknown>) => unknown;
    goodbye: (nodeId: string) => unknown;
    onFail: {
        on: (cb: () => void) => () => void;
    };
};
export type ScaleAuthorityLeadership = {
    role?: tScaleAuthorityRole;
    epoch?: number;
    upstream?: () => Promise<AuthorityUpstream> | AuthorityUpstream;
    autoPromoteMs?: number;
    elect?: StoreReplicaLeadership['elect'];
    accept?: StoreReplicaLeadership['accept'];
};
export type ScaleDurableLine = Pick<DurableStoreDeps<object>, 'storage' | 'everyEvents' | 'everyMs'>;
export type ScaleAuthorityDeps<T extends Record<string, any>, Cmds extends tCommandMap = {}> = {
    line: Omit<StoreLineCoordinates, 'nodeId'> & {
        nodeId?: string;
        initial: T;
        durable?: ScaleDurableLine;
    };
    roster: {
        url: () => string;
        weight?: number;
        heartbeatMs?: number;
        staleMs?: number;
        acceptNode?: (nodeId: string) => boolean;
        meta?: () => Record<string, unknown>;
    };
    identity: ScaleIdentityAdapter;
    control?: {
        durable?: ScaleDurableLine;
    };
    corridor?: {
        commands?: Cmds;
        limits?: CommandHostDeps<Cmds>['limits'];
        receipts?: Omit<NonNullable<CommandHostDeps<Cmds>['receipts']>, 'line'>;
    };
    leadership?: ScaleAuthorityLeadership;
    log?: (line: string) => void;
};
export declare function createAuthority<T extends Record<string, any>, Cmds extends tCommandMap = {}>(deps: ScaleAuthorityDeps<T, Cmds>): {
    line: {
        control: {
            store: Store<T>;
            addOffer: (offerValue: import("../Observe").StoreReplicaOffer<T>) => () => void;
            removeOffer: (id: string) => boolean;
            setOffers: (next: readonly import("../Observe").StoreReplicaOffer<T>[]) => void;
            probe: () => Promise<void>;
            reconcile: (reason?: string) => Promise<void>;
            promote: (reason?: string) => Promise<import("../Observe").StoreReplicaDescriptor | null>;
            canWrite: () => boolean;
            close: () => void;
        };
        api: {
            store: Store<T>;
            status: Store<import("../Observe").StoreReplicaSetStatus>;
            ready: Promise<void>;
            descriptor: () => import("../Observe").StoreReplicaDescriptor;
            changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
            conflicts: import("../..").ListenApi<[import("../Observe").StoreReplicaConflict<T>]>;
            routes: import("../..").ListenApi<[import("../Observe").StoreReplicaRouteEvent]>;
            replay: {
                has(key: import("../..").ListenKey): boolean;
                off(keyOrCallback: import("../..").Listener<[readonly import("../Observe").StorePatch[]]> | import("../..").ListenKey | null): void;
                count(): number;
                keys(): import("../..").ListenKey[];
                isRunning(): boolean;
                run(): void;
                onClose(cb: () => void): import("../..").ListenOff;
                emit: import("../..").Listener<[readonly import("../Observe").StorePatch[]]>;
                emitBatch: (events: readonly [readonly import("../Observe").StorePatch[]][]) => void;
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
                line: import("../..").ListenApi<[import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]>]>;
                hasKeyframe: boolean;
                on: import("../events/replay-listen").ListenOnReplay<[readonly import("../Observe").StorePatch[]]>;
                once: (cb: import("../..").Listener<[readonly import("../Observe").StorePatch[]]>, opts?: {
                    key?: string | symbol;
                    current?: import("../..").ListenCurrent<[readonly import("../Observe").StorePatch[]]> | undefined;
                }) => import("../..").ListenOff;
                getSince(seq: number): import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]>[] | undefined;
                keyframe(): import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]> | undefined;
                frame(seq: number, hint?: unknown): import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]>[];
            };
            fragment: {
                descriptor: () => import("../Observe").StoreReplicaDescriptor;
                changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Observe").StoreReplayLineLocal;
                })) & import("../Observe").StoreReplayState<T>;
                ping: () => number;
            };
            canWrite: () => boolean;
        };
    };
    roster: {
        control: {
            set: (row: NodeDirectoryRow) => void;
            patch: (id: string, partial: Parameters<NodeDirectory['control']['patch']>[1]) => boolean;
            heartbeat: (id: string, partial?: Parameters<NodeDirectory['control']['heartbeat']>[1]) => boolean;
            drain: (id: string) => boolean;
            undrain: (id: string, w?: number) => boolean;
            remove: (id: string) => void;
            get: (id: string) => import("../Observe").NodeDirectoryEntry;
            snapshot: () => Record<string, import("../Observe").NodeDirectoryEntry>;
        };
        readonly api: StoreReplayRemote;
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
        principal: (presented: unknown) => StoreNodePrincipal;
    };
    corridor: {
        execute: <K extends keyof Cmds & string>(account: string, command: K, requestId: string, input: Parameters<Cmds[K]>[1]) => Promise<Awaited<ReturnType<Cmds[K]>>>;
        names: (keyof Cmds & string)[];
        fragment: (account: string) => CommandFragment<Cmds>;
        byToken: () => import("../command/command-token").CommandTokenFragment<Cmds>;
    };
    serve: {
        browser: (account: string) => {
            replica: {
                descriptor: () => import("../Observe").StoreReplicaDescriptor;
                changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Observe").StoreReplayLineLocal;
                })) & import("../Observe").StoreReplayState<T>;
                ping: () => number;
            };
            roster: StoreReplayRemote;
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
        };
        reader: () => {
            replica: {
                descriptor: () => import("../Observe").StoreReplicaDescriptor;
                changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Observe").StoreReplayLineLocal;
                })) & import("../Observe").StoreReplayState<T>;
                ping: () => number;
            };
            node: () => string;
        };
        nodeLink: (linkNodeId?: string) => {
            replica: {
                descriptor: () => import("../Observe").StoreReplicaDescriptor;
                changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
                replay: ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } & import("../Observe").StoreReplayLineLocal;
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                    describe: () => Record<string, any>;
                } | ({
                    line: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    };
                    since: (seq: number) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined;
                    keyframe: () => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                    frame?: ((seq: number, hint?: unknown) => import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2[] | null | undefined> | null | undefined) | undefined;
                    frameLine?: {
                        on: (cb: (batch: import("../Observe/store-replay-codec").tStoreReplayWireBatchV2) => void) => any;
                    } | undefined;
                    chunks?: {
                        begin: (opts?: {
                            budgetBytes?: number;
                        }) => Promise<import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined> | import("../Observe").StoreReplayChunksBegin<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2> | null | undefined;
                        pull: (snapshotId: string, index: number) => Promise<import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined> | import("../Observe/store-replay-codec").tStoreReplayWireBatchV2 | null | undefined;
                        end?: (snapshotId: string) => unknown;
                    } | undefined;
                } & {
                    line: import("../Observe").StoreReplayLineLocal;
                })) & import("../Observe").StoreReplayState<T>;
                ping: () => number;
            };
            control: StoreReplayRemote;
            commandsByToken: import("../command/command-token").CommandTokenFragment<Cmds>;
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
            }): {
                ok: boolean;
            };
            goodbye(id: unknown): {
                ok: boolean;
            };
        };
        connection: {
            <F extends Record<string, unknown>>(shape: {
                principal: AuthorityPrincipalShaper<T, Cmds, F>;
            }): AuthorityConnection<F>;
            (shape?: {
                principal?: undefined;
            }): AuthorityConnection<AuthorityPrincipalFacade<T, Cmds>>;
        };
    };
    control: {
        promote: (reason?: string) => Promise<import("../Observe").StoreReplicaDescriptor | null>;
    };
    events: {
        role: import("../..").ListenApi<[tScaleAuthorityRole, {
            leaderId: string | null;
            epoch: number;
        }]>;
    };
    view: {
        role: () => tScaleAuthorityRole;
        leaderId: () => string | null;
        epoch: () => number;
        nodes: () => import("../Observe").NodeDirectoryView[];
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
    };
    start: () => void;
    close: () => void;
};
export type ScaleAuthority<T extends Record<string, any> = Record<string, any>, Cmds extends tCommandMap = {}> = ReturnType<typeof createAuthority<T, Cmds>>;
