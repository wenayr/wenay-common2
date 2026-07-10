export declare class MyError<D = unknown> extends Error {
    readonly code: string;
    readonly data: D;
    name: string;
    constructor(message: string, code?: string, data?: D, cause?: unknown);
    toJSON(): {
        name: string;
        message: string;
        code: string;
        data: D;
        stack: string | undefined;
    };
    static wrap(e: unknown): Error;
    static fromWire<D>(w: tWire<D>): MyError<D> & {
        name: string;
        stack: string | undefined;
    };
}
export type tWire<D = unknown> = ReturnType<MyError<D>['toJSON']>;
export declare const toError: {
    convert: any;
    throw(e: any): void;
    convertToMsg(e: any): any;
};
