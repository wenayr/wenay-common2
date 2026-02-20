export function NormalizeLot(lot: number,minQty: number, stepSize: number){
    const x = Math.floor((lot-minQty)/stepSize)*stepSize+minQty
    return x < minQty ? minQty : x
}