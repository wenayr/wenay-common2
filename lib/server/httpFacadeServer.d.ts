import type { Express, RequestHandler } from 'express';
import { type RpcLimits } from '../Common/rcp/rpc-limits';
export type tHttpFacadeMethod = 'get' | 'post';
export type HttpFacadeServerOptions<T extends object> = {
    app: Pick<Express, 'get' | 'post'>;
    object: T;
    method: tHttpFacadeMethod;
    basePath: string;
    middleware?: RequestHandler | readonly RequestHandler[];
    limits?: RpcLimits;
};
export declare function createHttpFacadeServer<T extends object>(options: HttpFacadeServerOptions<T>): {
    routes: () => {
        method: tHttpFacadeMethod;
        path: string[];
        route: string;
    }[];
};
export type HttpFacadeServer = ReturnType<typeof createHttpFacadeServer>;
