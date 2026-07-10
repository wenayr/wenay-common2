type tCorrelationByBuffer = {
    max: number;
    bufferOn?: boolean;
};
export declare function CorrelationRollingByBuffer(data: tCorrelationByBuffer): {
    init(data: tCorrelationByBuffer): void;
    clear(data?: tCorrelationByBuffer): void;
    remove(key1: any, key2?: any): void;
    corr2(val1: number, val2: number, key1: any, key2: any): {
        corr: number;
    };
};
export {};
