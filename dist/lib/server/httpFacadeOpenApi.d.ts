import type { tHttpFacadeMethod } from './httpFacadeServer';
import { type RpcLimits } from '../Common/rcp/rpc-limits';
export type HttpFacadeOpenApiDeps = {
    object: object;
    basePath: string;
    methods: readonly tHttpFacadeMethod[];
    info: {
        title: string;
        version: string;
        description?: string;
    };
    bearerAuth?: boolean;
    limits?: RpcLimits;
    summaries?: Record<string, string>;
    argSchemas?: Record<string, readonly object[]>;
};
export declare function createHttpFacadeOpenApi(deps: HttpFacadeOpenApiDeps): {
    document: () => Record<string, unknown>;
    routes: () => {
        method: tHttpFacadeMethod;
        route: string;
    }[];
};
export type HttpFacadeOpenApi = ReturnType<typeof createHttpFacadeOpenApi>;
