import type { RpcServerControl } from '../rcp/rpc-server';
import { type CommandFragment, type CommandHostDeps, type tCommandMap } from '../command/command-host';
import { type NodeDirectory, type NodeDirectoryRow } from '../Observe/node-directory';
import type { StoreReplayRemote } from '../Observe/store-replay';
import { type StoreLineCoordinates, type StoreReplicaLeadership, type StoreReplicaSession } from '../Observe/store-replica-set';
import type { StoreNodePrincipal } from '../Observe/store-node';
export type ScaleIdentityAdapter = {
    issue: (account: string) => string;
    verify: (presented: unknown) => StoreNodePrincipal;
    renewBeforeMs?: number;
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
export type ScaleAuthorityDeps<T extends Record<string, any>, Cmds extends tCommandMap = {}> = {
    line: Omit<StoreLineCoordinates, 'nodeId'> & {
        nodeId?: string;
        initial: T;
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
            store: import("../Observe").Store<T>;
            addOffer: (offerValue: import("../Observe").StoreReplicaOffer) => () => void;
            removeOffer: (id: string) => boolean;
            setOffers: (next: readonly import("../Observe").StoreReplicaOffer[]) => void;
            probe: () => Promise<void>;
            reconcile: (reason?: string) => Promise<void>;
            promote: (reason?: string) => Promise<import("../Observe").StoreReplicaDescriptor | null>;
            canWrite: () => boolean;
            close: () => void;
        };
        api: {
            store: import("../Observe").Store<T>;
            status: import("../Observe").Store<import("../Observe").StoreReplicaSetStatus>;
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
                }) => () => void;
                getSince(seq: number): import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]>[] | undefined;
                keyframe(): import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]> | undefined;
                frame(seq: number, hint?: unknown): import("../events/replay-listen").ReplayEvent<[readonly import("../Observe").StorePatch[]]>[];
            };
            fragment: {
                descriptor: () => import("../Observe").StoreReplicaDescriptor;
                changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
                replay: {
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
                });
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
                replay: {
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
                });
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
                replay: {
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
                });
                ping: () => number;
            };
            node: () => string;
        };
        nodeLink: (linkNodeId?: string) => {
            replica: {
                descriptor: () => import("../Observe").StoreReplicaDescriptor;
                changed: import("../..").ListenApi<[import("../Observe").StoreReplicaDescriptor]>;
                replay: {
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
                });
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
        connection: () => {
            object: {};
            auth: {
                gate: boolean;
                resolveAuth: (presented: unknown) => {
                    object: {
                        whoami: () => string;
                        commands: CommandFragment<Cmds>;
                        revoke: () => {
                            revoked: true;
                            account: string;
                            sessionsCut: number;
                        };
                    };
                    ack: {
                        ok: boolean;
                        who: string;
                        node: string;
                    };
                    expiresAt?: number | undefined;
                    renewBeforeMs: number;
                };
            };
            attach(attached: RpcServerControl): void;
            close(): void;
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
    };
    start: () => void;
    close: () => void;
};
export type ScaleAuthority<T extends Record<string, any> = Record<string, any>, Cmds extends tCommandMap = {}> = ReturnType<typeof createAuthority<T, Cmds>>;
