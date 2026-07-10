export type MilliSec = number;
type tInputBaseR = {
    [key: string]: boolean | number | string | string[];
};
export type tInputBase = {
    timestamp?: MilliSec;
    recvWindow?: MilliSec;
} & tInputBaseR;
type tSignatureData = tInputBase;
type HmacCreator = (algorithm: string, key: string) => {
    update: (data: string) => {
        digest: (encoding: string) => unknown;
    };
};
export declare function createSignatureFunction<T extends HmacCreator>(hmacCreator: T): (params: tSignatureData, apiSecret: string) => unknown;
export type SignatureFunction = ReturnType<typeof createSignatureFunction>;
export {};
