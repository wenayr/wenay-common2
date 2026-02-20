export type tSymbolData = {
    name:   string,
    fullName:   string,
    tickSize:   number,
    minPrice:   number,
    minStepLot: number, //minQty stepSize
    minQty:     number,
    stepSize:   number,
    quoteAsset: string,
    baseAsset:  string
}