
type tDatumL = {price: number[], key: string|object|number}
type tfLeaderResultL = {}

function strategyStepOfStepAllL(symbols: tDatumL[]) {
    // минимальный процент всплеска
    const minK =  0
    const percentM =  1/100;
    type tResult = {leadersKey: {key: string|object|number, score: number}[], leadersId: (number)[], id: number, key: string|object|number}
    const result : tResult[] = []
    for (let i = 0; i < symbols.length; i++) {
        const tt: tResult = {key: symbols[i].key, id: i, leadersId: [], leadersKey: []} as tResult
        result.push(tt)
        for (let y = 0; y < symbols.length; y++) {
            if (i == y) continue;
            const r = strategyStepOfStepL({t1: symbols[i].price, t2: symbols[y].price, minK, percentM})
            if (r > 0) {
                tt.leadersKey.push({key: symbols[y].key, score: r })
                tt.leadersId.push(y)

            }
        }
    }
    return result
}

// t1 - суммарный процент изменения
type tStepOfStepL = {
    // symPercent
    t1: number[],
    // symPercent - leader
    t2: number[],
    minK?: number ,percentM?: number, onlyBuy?: boolean}
// стратегия лана


function PriceTOSumPercentL(price: number[]) {
    return price.map(e=>e/price[0])
}

function strategyStepOfStepL({t1, t2, minK: _minK, percentM: _percentM, onlyBuy: _onlyBuy}: tStepOfStepL) {
    const onlyBuy = !!_onlyBuy
    const minK = _minK ?? 0
    const percentM = _percentM ?? 1/100;


    // процент изменения цены которые привязывается к нулю со скоростью percentM
    const conArr = (arr: number[]) => {
        let last = arr[0], result = 0;
        return arr.map(e=>{
            const r = e - last;
            last = e
            result +=r;
            result = result * (1 - percentM) // + (0)*(percentM)
            return result
        })
    }

    const [r1,r2] = [t1,t2].map(e=> conArr(e))

    const length = r1.length
    let m1 = 0, m2 = 0
    //
    const result1: number[] = [0]
    // прошлый объем
    let [lastD1, lastD2] = [0,0]
    for (let i = 1; i < length; i++) {
        // сила и направление
        const [d1,d2] = [r1[i],r2[i]]
        // приращение
        const [p1,p2] = [t1[i] - t1[i-1], t2[i] - t2[i-1]]

        const pLana = p1-p2



        result1.push(p1*d2);
        [lastD1, lastD2] = [d1,d2]
    }

    const day = {profitDays: 0, lossDays: 0, profit: 0, loss: 0}
    for (let i = 0; i < result1.length; i++) {
        if (result1[i] > 0) {
            day.profitDays ++
            day.profit += result1[i]
        }
        if (result1[i] < 0) {
            day.lossDays ++
            day.loss += result1[i]
        }
    }
    const k1 = day.profitDays / result1.length
    const k2 = day.profit / ((day.profit + day.loss) || 1)
    return k1 * k2
}