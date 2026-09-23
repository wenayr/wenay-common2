import type { Express } from 'express';
import type { RpcLimits } from '../Common/rcp/rpc-limits';
import type { ServiceLeader } from './leader';
import type { tServiceDefinition } from './definition';
export type ServiceRestDeps<D extends tServiceDefinition<any, any>> = {
    app: Express;
    leader: ServiceLeader<D>;
    definition: D;
    info?: {
        title?: string;
        version?: string;
        description?: string;
    };
    pages?: {
        panel?: boolean;
        docs?: boolean;
    };
    limits?: RpcLimits;
};
export declare function createServiceRest<D extends tServiceDefinition<any, any>>(deps: ServiceRestDeps<D>): {
    basePath: string;
    routes: {
        read: {
            method: import("../server").tHttpFacadeMethod;
            path: string[];
            route: string;
        }[];
        write: {
            method: import("../server").tHttpFacadeMethod;
            path: string[];
            route: string;
        }[];
    };
    openApi: {
        document: () => {
            openapi: any;
            info: any;
            paths: Record<string, unknown>;
            components: any;
        };
    };
};
export type ServiceRest = ReturnType<typeof createServiceRest>;
