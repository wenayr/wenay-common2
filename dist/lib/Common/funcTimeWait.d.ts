export type tApiKey = string;
type tType = "UID" | "IP" | tApiKey;
type tFunc = {
    timeStamp?: number;
    type: tType;
    weight: number;
};
export declare function funcTimeW(): {
    dStatic: {
        [key: string]: [number, number][];
    };
    data: any[];
    add(item: tFunc): void;
    cleanByTime(type: tType, ms?: number): void;
    weight(type: tType, ms?: number): number;
    byWeight(type: tType, weight?: number): number;
    byWeightTimeNow(type: tType, timeNow?: number, weight?: number): number;
};
export declare const FuncTimeWait: {
    dStatic: {
        [key: string]: [number, number][];
    };
    data: any[];
    add(item: tFunc): void;
    cleanByTime(type: tType, ms?: number): void;
    weight(type: tType, ms?: number): number;
    byWeight(type: tType, weight?: number): number;
    byWeightTimeNow(type: tType, timeNow?: number, weight?: number): number;
};
export declare function createRateWindow(): {
    prune: (type: tType, ms?: number) => void;
    sumWeight: (type: tType, ms?: number) => number;
    readyAt: (type: tType, weight?: number) => number;
    dStatic: {
        [key: string]: [number, number][];
    };
    data: any[];
    add(item: tFunc): void;
    cleanByTime(type: tType, ms?: number): void;
    weight(type: tType, ms?: number): number;
    byWeight(type: tType, weight?: number): number;
    byWeightTimeNow(type: tType, timeNow?: number, weight?: number): number;
};
export declare const rateWindow: {
    prune: (type: tType, ms?: number) => void;
    sumWeight: (type: tType, ms?: number) => number;
    readyAt: (type: tType, weight?: number) => number;
    dStatic: {
        [key: string]: [number, number][];
    };
    data: any[];
    add(item: tFunc): void;
    cleanByTime(type: tType, ms?: number): void;
    weight(type: tType, ms?: number): number;
    byWeight(type: tType, weight?: number): number;
    byWeightTimeNow(type: tType, timeNow?: number, weight?: number): number;
};
export {};
