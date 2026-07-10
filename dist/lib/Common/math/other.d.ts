type tDatum = {
    price: number[];
    key: string | object | number;
};
type tfLeaderResult = {};
declare function PriceTOSumPercent(price: number[]): number[];
declare function strategyStepOfStepAll(symbols_: tDatum[]): {
    leadersKey: {
        key: string | object | number;
        score: number;
    }[];
    leadersId: (number)[];
    id: number;
    key: string | object | number;
}[];
type tStepOfStep = {
    t1: number[];
    t2: number[];
    minK?: number;
    percentM?: number;
    onlyBuy?: boolean;
};
declare function strategyStepOfStep({ t1, t2, minK: _minK, percentM: _percentM, onlyBuy: _onlyBuy }: tStepOfStep): number;
