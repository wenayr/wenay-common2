import type { Request, RequestHandler } from 'express';
import type { McpAttachSession, McpFacadeServer, McpFacadeSurface, McpServerLike } from './mcpFacadeServer';
export type McpAuthGrant = {
    object?: object;
    principal?: unknown;
    expiresAt?: number;
};
export type McpFacadeHttpOptions = {
    app: {
        post: (path: string, ...handlers: RequestHandler[]) => unknown;
        get: (path: string, ...handlers: RequestHandler[]) => unknown;
        delete: (path: string, ...handlers: RequestHandler[]) => unknown;
    };
    path: string;
    mcp: McpFacadeServer;
    mode?: 'stateful' | 'stateless';
    maxSessions?: number;
    sessionTtlMs?: number;
    maxBodyBytes?: number;
    middleware?: RequestHandler | readonly RequestHandler[];
    auth?: {
        resolveAuth: (token: string, req: Request) => McpAuthGrant | Promise<McpAuthGrant>;
    };
    enableJsonResponse?: boolean;
    now?: () => number;
};
declare function createSessionEvent(id: string, principal: unknown, reason?: string): {
    id: string;
    principal: unknown;
    reason?: string | undefined;
};
export type McpSessionEvent = ReturnType<typeof createSessionEvent>;
export declare function createMcpFacadeHttp(options: McpFacadeHttpOptions): {
    sessions: {
        list: () => {
            id: string;
            principal: unknown;
            createdAt: number;
            lastSeenAt: number;
            active: number;
        }[];
        count: () => number;
    };
    control: {
        terminate: (id: string) => Promise<boolean>;
        evictIdle: () => void;
        dispose: () => Promise<void>;
    };
    on: {
        opened: import("..").ListenOn<[{
            id: string;
            principal: unknown;
            reason?: string | undefined;
        }]>;
        closed: import("..").ListenOn<[{
            id: string;
            principal: unknown;
            reason?: string | undefined;
        }]>;
    };
};
export type McpFacadeHttp = ReturnType<typeof createMcpFacadeHttp>;
export declare function serveMcpStdio(mcp: McpFacadeSurface, session?: McpAttachSession): Promise<{
    server: McpServerLike;
    close: () => Promise<void>;
}>;
export {};
