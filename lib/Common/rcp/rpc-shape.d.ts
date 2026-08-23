import { type RpcLimits } from './rpc-limits';
import type { tRowCodec } from './rpc-walk';
export declare function isPlainObject(v: any): boolean;
export declare function createCbShapeServer(threshold?: number, maxShapes?: number): {
    offer: (cbId: number, obj: any) => {
        mode: 'full';
        shapeId?: undefined;
        keys?: undefined;
    } | {
        mode: "compact";
        shapeId: number;
        keys: string[];
    } | {
        mode: "register";
        shapeId: number;
        keys: string[];
    };
    drop: (cbId: number) => void;
};
export declare function createShapeRegistry(threshold?: number, maxShapes?: number, minRows?: number): {
    offerTick: (sessionId: number, obj: any) => {
        mode: 'full';
    } | {
        mode: 'compact';
        shapeId: number;
        keys: string[];
    } | {
        mode: 'register';
        shapeId: number;
        keys: string[];
    };
    offerRows: (arr: any[]) => {
        shapeId: number;
        keys: string[];
    } | null;
    forgetSession: (sessionId: number) => void;
    size: () => number;
};
export type tShapeRegistry = ReturnType<typeof createShapeRegistry>;
export declare function createShapeDecoder(maxShapes?: number): {
    declare: (shapeId: number, keys: string[]) => void;
    keysOf: (shapeId: number) => string[] | undefined;
    clear: () => void;
    size: () => number;
};
export type tShapeDecoder = ReturnType<typeof createShapeDecoder>;
export declare function createRowEncoder(registry: tShapeRegistry): tRowCodec;
export declare function createRowDecoder(lim?: Required<RpcLimits>): tRowCodec;
