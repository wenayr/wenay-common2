import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type RpcLimits } from '../Common/rcp/rpc-limits';
import { type FacadeDynamicMeta, type FacadeMethodMeta, type McpToolAnnotations, type tFacadeMetaMap } from './facadeMeta';
declare const NAME_RULES: {
    readonly mcp: {
        readonly pattern: RegExp;
        readonly disallowed: RegExp;
        readonly max: 128;
    };
    readonly claude: {
        readonly pattern: RegExp;
        readonly disallowed: RegExp;
        readonly max: 64;
    };
};
export type tMcpToolNameCharset = keyof typeof NAME_RULES;
export type tMcpConcurrency = 'serial' | 'parallel';
export type tMcpDynamic = false | 'read' | 'call';
export type McpServerLike = {
    setRequestHandler(schema: any, handler: (request: any, extra: any) => unknown): void;
    removeRequestHandler(method: string): void;
    assertCanSetRequestHandler(method: string): void;
    registerCapabilities(capabilities: Record<string, unknown>): void;
    readonly transport?: unknown;
    onclose?: () => void;
    sendToolListChanged(): Promise<void>;
    sendResourceListChanged(): Promise<void>;
    sendResourceUpdated(params: {
        uri: string;
    }): Promise<void>;
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
};
export type McpJsonSchemaValidator = {
    getValidator(schema: any): (input: unknown) => {
        valid: boolean;
        errorMessage?: string;
    };
};
type tSchemaCheck = ReturnType<McpJsonSchemaValidator['getValidator']>;
export type McpCallScope = {
    session: {
        id: string;
    };
    principal: unknown;
    signal: AbortSignal;
    progress: (progress: number, total?: number, message?: string) => void;
};
declare function createToolContext(scope: McpCallScope): {
    signal: AbortSignal;
    progress: (progress: number, total?: number, message?: string) => void;
    session: {
        id: string;
    };
    principal: unknown;
};
export type McpToolContext = ReturnType<typeof createToolContext>;
declare function createCallContext(tool: string, path: readonly string[], args: readonly unknown[], readOnly: boolean, scope: McpCallScope): {
    tool: string;
    path: readonly string[];
    args: readonly unknown[];
    readOnly: boolean;
    session: {
        id: string;
    };
    principal: unknown;
    signal: AbortSignal;
};
export type McpCallContext = ReturnType<typeof createCallContext>;
export type McpAround = (ctx: McpCallContext, next: () => Promise<unknown>) => unknown;
export type McpFacadePolicy = {
    readOnly?: (path: readonly string[]) => boolean | undefined;
    concurrency?: (path: readonly string[]) => tMcpConcurrency;
    resource?: (path: readonly string[]) => boolean;
    dynamic?: (path: readonly string[]) => tMcpDynamic | undefined;
};
export type McpFacadeFinding = {
    path: string;
    message: string;
};
export type McpFacadeServerOptions<T extends object> = {
    name: string;
    version: string;
    instructions?: string;
    object: T;
    meta?: tFacadeMetaMap;
    strict?: boolean;
    readOnly?: boolean;
    policy?: McpFacadePolicy;
    around?: McpAround | readonly McpAround[];
    formatResult?: (path: readonly string[], value: unknown) => CallToolResult | undefined;
    limits?: RpcLimits;
    names?: {
        separator?: string;
        charset?: tMcpToolNameCharset;
        map?: boolean;
    };
    resources?: false | {
        scheme?: string;
        maxSubscriptions?: number;
        completions?: boolean;
    };
    validator?: McpJsonSchemaValidator | false;
    onFinding?: (finding: McpFacadeFinding) => void;
};
export type McpAttachSession = {
    id?: string;
    principal?: unknown;
};
declare function createShared<T extends object>(deps: McpFacadeServerOptions<T>): {
    deps: McpFacadeServerOptions<T>;
    rule: {
        readonly pattern: RegExp;
        readonly disallowed: RegExp;
        readonly max: 128;
    } | {
        readonly pattern: RegExp;
        readonly disallowed: RegExp;
        readonly max: 64;
    };
    scheme: string;
    resourceOptions: {
        scheme?: string;
        maxSubscriptions?: number;
        completions?: boolean;
    } | null;
    maxSubscriptions: number;
    completions: boolean;
    limits: Required<RpcLimits>;
    metaMap: Readonly<Record<string, FacadeMethodMeta>> | undefined;
    around: any[];
    queue: {
        add: <T_1>(task: () => Promise<T_1>) => Promise<T_1>;
        onIdle: () => Promise<void>;
        readonly size: number;
        enqueue: <T_1>(task: () => Promise<T_1>) => Promise<T_1>;
        getQueueSize: () => number;
    };
    disposal: AbortController;
    attachments: Set<tAttachment>;
    findings: McpFacadeFinding[];
    events: {
        emitCalled: import("..").Listener<[{
            tool: string;
            path: readonly string[];
            session: {
                id: string;
            };
            principal: unknown;
            durationMs: number;
        }]>;
        emitFailed: import("..").Listener<[McpFailEvent]>;
        called: import("..").ListenApi<{
            tool: string;
            path: readonly string[];
            session: {
                id: string;
            };
            principal: unknown;
            durationMs: number;
        }>;
        failed: import("..").ListenApi<McpFailEvent>;
    };
    toolName: (path: readonly string[]) => string;
    resourceUri: (path: readonly string[]) => string;
    resourcePath: (uri: string) => string[] | null;
    compiled: (meta: FacadeMethodMeta) => {
        input?: tSchemaCheck;
        output?: tSchemaCheck;
    };
    compiledKey: (meta: FacadeDynamicMeta) => ((input: unknown) => {
        valid: boolean;
        errorMessage?: string;
    }) | undefined;
    dispatchInput: (meta: FacadeDynamicMeta | undefined, depth: number) => {
        schema: Record<string, unknown>;
        check?: tSchemaCheck;
    };
    report: (finding: McpFacadeFinding) => void;
    reportDynamic: (node: readonly string[], member: readonly string[], message: string) => void;
};
type tShared = ReturnType<typeof createShared>;
type tSubscription = {
    off: () => void;
    source: unknown;
};
type tAttachment = {
    server: McpServerLike;
    resources: boolean;
    sessionId: string;
    principal: unknown;
    subscriptions: Map<string, tSubscription>;
    pending: Set<string>;
    surface: object;
    closed: boolean;
    detach: () => void;
};
declare function createCallEvent(tool: string, path: readonly string[], session: {
    id: string;
}, principal: unknown, durationMs: number): {
    tool: string;
    path: readonly string[];
    session: {
        id: string;
    };
    principal: unknown;
    durationMs: number;
};
export type McpCallEvent = ReturnType<typeof createCallEvent>;
export type McpFailEvent = McpCallEvent & {
    error: unknown;
};
declare function createSurface(shared: tShared, root: object, checkStaleMeta: boolean): {
    tools: {
        list: () => {
            name: string;
            title?: string | undefined;
            description: string;
            inputSchema: {
                type: 'object';
                [key: string]: unknown;
            };
            outputSchema?: {
                [key: string]: unknown;
                type: 'object';
            } | undefined;
            annotations?: McpToolAnnotations | undefined;
        }[];
        call: (name: string, input?: Record<string, unknown>, scope?: Partial<McpCallScope>) => Promise<{
            [x: string]: unknown;
            _meta?: {
                [x: string]: unknown;
                progressToken?: string | number | undefined;
                "io.modelcontextprotocol/related-task"?: {
                    taskId: string;
                } | undefined;
            } | undefined;
            content: ({
                type: "text";
                text: string;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                type: "image";
                data: string;
                mimeType: string;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                type: "audio";
                data: string;
                mimeType: string;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                uri: string;
                description?: string | undefined;
                mimeType?: string | undefined;
                size?: number | undefined;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
                icons?: {
                    src: string;
                    mimeType?: string | undefined;
                    sizes?: string[] | undefined;
                    theme?: "dark" | "light" | undefined;
                }[] | undefined;
                name: string;
                title?: string | undefined;
                type: "resource_link";
            } | {
                type: "resource";
                resource: {
                    uri: string;
                    mimeType?: string | undefined;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                    text: string;
                } | {
                    uri: string;
                    mimeType?: string | undefined;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                    blob: string;
                };
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            })[];
            structuredContent?: {
                [x: string]: unknown;
            } | undefined;
            isError?: boolean | undefined;
        }>;
    };
    resources: {
        list: () => {
            uri: string;
            name: string;
            title?: string | undefined;
            description: string;
            mimeType: string;
        }[];
        templates: () => {
            uriTemplate: string;
            name: string;
            title?: string | undefined;
            description: string;
            mimeType: string;
        }[];
        read: (uri: string, scope?: Partial<McpCallScope>) => Promise<{
            contents: {
                uri: string;
                mimeType: string;
                text: string;
            }[];
        }>;
    };
    control: {
        attach: (target: McpServerLike | {
            server: McpServerLike;
        }, session?: McpAttachSession) => () => void;
        server: (session?: McpAttachSession) => McpServerLike;
        mount: (key: string, object: object) => {
            tools: boolean;
            resources: boolean;
        };
        replace: (key: string, object: object) => {
            tools: boolean;
            resources: boolean;
        };
        unmount: (key: string) => {
            tools: boolean;
            resources: boolean;
        };
        refresh: () => {
            tools: boolean;
            resources: boolean;
        };
    };
    view: {
        findings: () => McpFacadeFinding[];
        attached: () => number;
    };
};
export type McpFacadeSurface = ReturnType<typeof createSurface>;
export declare function createMcpFacadeServer<T extends object>(deps: McpFacadeServerOptions<T>): {
    tools: {
        list: () => {
            name: string;
            title?: string | undefined;
            description: string;
            inputSchema: {
                type: 'object';
                [key: string]: unknown;
            };
            outputSchema?: {
                [key: string]: unknown;
                type: 'object';
            } | undefined;
            annotations?: McpToolAnnotations | undefined;
        }[];
        call: (name: string, input?: Record<string, unknown>, scope?: Partial<McpCallScope>) => Promise<{
            [x: string]: unknown;
            _meta?: {
                [x: string]: unknown;
                progressToken?: string | number | undefined;
                "io.modelcontextprotocol/related-task"?: {
                    taskId: string;
                } | undefined;
            } | undefined;
            content: ({
                type: "text";
                text: string;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                type: "image";
                data: string;
                mimeType: string;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                type: "audio";
                data: string;
                mimeType: string;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            } | {
                uri: string;
                description?: string | undefined;
                mimeType?: string | undefined;
                size?: number | undefined;
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
                icons?: {
                    src: string;
                    mimeType?: string | undefined;
                    sizes?: string[] | undefined;
                    theme?: "dark" | "light" | undefined;
                }[] | undefined;
                name: string;
                title?: string | undefined;
                type: "resource_link";
            } | {
                type: "resource";
                resource: {
                    uri: string;
                    mimeType?: string | undefined;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                    text: string;
                } | {
                    uri: string;
                    mimeType?: string | undefined;
                    _meta?: {
                        [x: string]: unknown;
                    } | undefined;
                    blob: string;
                };
                annotations?: {
                    audience?: ("assistant" | "user")[] | undefined;
                    priority?: number | undefined;
                    lastModified?: string | undefined;
                } | undefined;
                _meta?: {
                    [x: string]: unknown;
                } | undefined;
            })[];
            structuredContent?: {
                [x: string]: unknown;
            } | undefined;
            isError?: boolean | undefined;
        }>;
    };
    resources: {
        list: () => {
            uri: string;
            name: string;
            title?: string | undefined;
            description: string;
            mimeType: string;
        }[];
        templates: () => {
            uriTemplate: string;
            name: string;
            title?: string | undefined;
            description: string;
            mimeType: string;
        }[];
        read: (uri: string, scope?: Partial<McpCallScope>) => Promise<{
            contents: {
                uri: string;
                mimeType: string;
                text: string;
            }[];
        }>;
    };
    view: {
        findings: () => McpFacadeFinding[];
        attached: () => number;
    };
    control: {
        attach: (target: McpServerLike | {
            server: McpServerLike;
        }, session?: McpAttachSession) => () => void;
        server: (session?: McpAttachSession) => McpServerLike;
        mount: (key: string, object: object) => {
            tools: boolean;
            resources: boolean;
        };
        replace: (key: string, object: object) => {
            tools: boolean;
            resources: boolean;
        };
        unmount: (key: string) => {
            tools: boolean;
            resources: boolean;
        };
        refresh: () => {
            tools: boolean;
            resources: boolean;
        };
        derive: (object: object) => {
            tools: {
                list: () => {
                    name: string;
                    title?: string | undefined;
                    description: string;
                    inputSchema: {
                        type: 'object';
                        [key: string]: unknown;
                    };
                    outputSchema?: {
                        [key: string]: unknown;
                        type: 'object';
                    } | undefined;
                    annotations?: McpToolAnnotations | undefined;
                }[];
                call: (name: string, input?: Record<string, unknown>, scope?: Partial<McpCallScope>) => Promise<{
                    [x: string]: unknown;
                    _meta?: {
                        [x: string]: unknown;
                        progressToken?: string | number | undefined;
                        "io.modelcontextprotocol/related-task"?: {
                            taskId: string;
                        } | undefined;
                    } | undefined;
                    content: ({
                        type: "text";
                        text: string;
                        annotations?: {
                            audience?: ("assistant" | "user")[] | undefined;
                            priority?: number | undefined;
                            lastModified?: string | undefined;
                        } | undefined;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                    } | {
                        type: "image";
                        data: string;
                        mimeType: string;
                        annotations?: {
                            audience?: ("assistant" | "user")[] | undefined;
                            priority?: number | undefined;
                            lastModified?: string | undefined;
                        } | undefined;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                    } | {
                        type: "audio";
                        data: string;
                        mimeType: string;
                        annotations?: {
                            audience?: ("assistant" | "user")[] | undefined;
                            priority?: number | undefined;
                            lastModified?: string | undefined;
                        } | undefined;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                    } | {
                        uri: string;
                        description?: string | undefined;
                        mimeType?: string | undefined;
                        size?: number | undefined;
                        annotations?: {
                            audience?: ("assistant" | "user")[] | undefined;
                            priority?: number | undefined;
                            lastModified?: string | undefined;
                        } | undefined;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                        icons?: {
                            src: string;
                            mimeType?: string | undefined;
                            sizes?: string[] | undefined;
                            theme?: "dark" | "light" | undefined;
                        }[] | undefined;
                        name: string;
                        title?: string | undefined;
                        type: "resource_link";
                    } | {
                        type: "resource";
                        resource: {
                            uri: string;
                            mimeType?: string | undefined;
                            _meta?: {
                                [x: string]: unknown;
                            } | undefined;
                            text: string;
                        } | {
                            uri: string;
                            mimeType?: string | undefined;
                            _meta?: {
                                [x: string]: unknown;
                            } | undefined;
                            blob: string;
                        };
                        annotations?: {
                            audience?: ("assistant" | "user")[] | undefined;
                            priority?: number | undefined;
                            lastModified?: string | undefined;
                        } | undefined;
                        _meta?: {
                            [x: string]: unknown;
                        } | undefined;
                    })[];
                    structuredContent?: {
                        [x: string]: unknown;
                    } | undefined;
                    isError?: boolean | undefined;
                }>;
            };
            resources: {
                list: () => {
                    uri: string;
                    name: string;
                    title?: string | undefined;
                    description: string;
                    mimeType: string;
                }[];
                templates: () => {
                    uriTemplate: string;
                    name: string;
                    title?: string | undefined;
                    description: string;
                    mimeType: string;
                }[];
                read: (uri: string, scope?: Partial<McpCallScope>) => Promise<{
                    contents: {
                        uri: string;
                        mimeType: string;
                        text: string;
                    }[];
                }>;
            };
            control: {
                attach: (target: McpServerLike | {
                    server: McpServerLike;
                }, session?: McpAttachSession) => () => void;
                server: (session?: McpAttachSession) => McpServerLike;
                mount: (key: string, object: object) => {
                    tools: boolean;
                    resources: boolean;
                };
                replace: (key: string, object: object) => {
                    tools: boolean;
                    resources: boolean;
                };
                unmount: (key: string) => {
                    tools: boolean;
                    resources: boolean;
                };
                refresh: () => {
                    tools: boolean;
                    resources: boolean;
                };
            };
            view: {
                findings: () => McpFacadeFinding[];
                attached: () => number;
            };
        };
        dispose: () => void;
    };
    on: {
        called: import("..").ListenOn<[{
            tool: string;
            path: readonly string[];
            session: {
                id: string;
            };
            principal: unknown;
            durationMs: number;
        }]>;
        failed: import("..").ListenOn<[McpFailEvent]>;
    };
};
export type McpFacadeServer = ReturnType<typeof createMcpFacadeServer>;
export {};
