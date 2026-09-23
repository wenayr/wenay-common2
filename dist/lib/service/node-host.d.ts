import type express from 'express';
import { type tServiceDefinition } from './definition';
import { type tEnv } from './config';
import { type ServiceHostOptions, type tServiceDisposer } from './host-lifecycle';
import { createServiceNode } from './node';
export type NodeProcessDeps<S extends Record<string, any>> = ServiceHostOptions & {
    definition: tServiceDefinition<S>;
    env?: tEnv;
    mount?: (host: {
        app: express.Express;
        node: ReturnType<typeof createServiceNode<S>>;
        url: () => string;
        signal: AbortSignal;
    }) => void | tServiceDisposer | Promise<void | tServiceDisposer>;
    graceMs?: number;
};
export declare function createServiceNodeHost<S extends Record<string, any>>(deps: NodeProcessDeps<S>): Promise<{
    node: {
        start: () => Promise<void>;
        leave: (reason: string) => void;
        view: {
            nodeId: string;
            status: () => {
                started: boolean;
                leaving: boolean;
                rehomes: number;
                readers: number;
                seq: number | undefined;
            };
        };
        close(): void;
    };
    url: string;
    publicUrl: string;
    app: import("express-serve-static-core").Express;
    httpServer: import("node:http").Server<typeof import("node:http").IncomingMessage, typeof import("node:http").ServerResponse>;
    close: () => Promise<void>;
    shutdown: () => Promise<void>;
}>;
export declare function runNodeProcess<S extends Record<string, any>>(deps: NodeProcessDeps<S>): Promise<{
    node: {
        start: () => Promise<void>;
        leave: (reason: string) => void;
        view: {
            nodeId: string;
            status: () => {
                started: boolean;
                leaving: boolean;
                rehomes: number;
                readers: number;
                seq: number | undefined;
            };
        };
        close(): void;
    };
    url: string;
    publicUrl: string;
    app: import("express-serve-static-core").Express;
    httpServer: import("node:http").Server<typeof import("node:http").IncomingMessage, typeof import("node:http").ServerResponse>;
    close: () => Promise<void>;
    shutdown: () => Promise<void>;
}>;
