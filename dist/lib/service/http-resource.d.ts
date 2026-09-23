import { Server, type ServerOptions } from 'socket.io';
export declare function createHostResource(deps: {
    host?: string;
    port: number;
    socket?: Omit<Partial<ServerOptions>, 'cors' | 'allowRequest'>;
    closeTimeoutMs?: number;
    origins?: () => readonly string[] | true;
}): {
    resource: {
        app: import("express-serve-static-core").Express;
        io: Server<import("socket.io").DefaultEventsMap, import("socket.io").DefaultEventsMap, import("socket.io").DefaultEventsMap, any>;
        server: import("node:http").Server<typeof import("node:http").IncomingMessage, typeof import("node:http").ServerResponse>;
    };
    control: {
        listen: () => Promise<void>;
    };
    view: {
        url: () => string;
    };
    close: () => Promise<void>;
};
export type HostResource = ReturnType<typeof createHostResource>;
