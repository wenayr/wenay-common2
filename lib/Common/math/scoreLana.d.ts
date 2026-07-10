type tDatumL = {
    price: number[];
    key: string | object | number;
};
export declare function strategyStepOfStepAllL(symbols: tDatumL[]): {
    leadersKey: {
        key: string | object | number;
        score: number;
    }[];
    leadersId: (number)[];
    id: number;
    key: string | object | number;
}[];
type tStepOfStepL = {
    t1: number[];
    t2: number[];
    minK?: number;
    percentM?: number;
    onlyBuy?: boolean;
};
export declare function strategyStepOfStepL({ t1, t2, minK: _minK, percentM: _percentM, onlyBuy: _onlyBuy }: tStepOfStepL): number;
export {};
