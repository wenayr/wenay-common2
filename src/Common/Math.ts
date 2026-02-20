


type tCorrelationByBuffer = {max: number, bufferOn?: boolean}
export function CorrelationRollingByBuffer(data: tCorrelationByBuffer) {
    let setting: tCorrelationByBuffer = {...data};
    let total = 0
    const map = new Map<object, Map<object,tCorrBuffer>>()
    // @ts-ignore
    const defBuf = (): tCorrBuffer => ({last1: 0, last2: 0, mulSum: 0, pow1:0 , pow2: 0, sum2:0 , sum1: 0, step: 0, first1:0 , first2: 0, total})
    const getBuffer = (key1: any, key2: any) => {
        let a1 = map.get(key1)
        if (!a1) map.set(key1, a1 = new Map<object,tCorrBuffer>())
        let a2 = a1.get(key2)
        if (!a2) a1.set(key2, a2 = defBuf())
        return a2
    }
    const map2 = new Map<object, Map<object,{ar1: number[], ar2: number[]}>>()
    const getBuffer2 = (key1: any, key2: any) => {
        let a1 = map2.get(key1)
        if (!a1) map2.set(key1, a1 = new Map())
        let a2 = a1.get(key2)
        if (!a2) a1.set(key2, a2 = {ar1: [], ar2: []})
        return a2
    }
    let index = 0;
    const clear = () => {
        index = 0;
        map.clear()
    }
    function checkSize(e: any[]){
        const a = e.length - setting.max
        if (a > 0) e.splice(0, a)
    }
    return ({
        init(data: tCorrelationByBuffer)    {setting = {...data}},
        clear(data?: tCorrelationByBuffer)  {clear(); data && this.init(data);},
        // set index(t:number) {index = t},
        // get index() {return index},
        corr(arr1: number[], arr2: number[], key1?: any, key2?: any) {
            let [k1, k2] = [key1 ?? arr1, key2 ?? arr2]
            const buffer = setting.bufferOn ? getBuffer(k1, k2) : null
            const a = CorrelationFunc(arr1, arr2, {rolling: setting.max, buffer})
            // if (setting.bufferOn && a.buffer) {
            //     map.get(k1)!.set(k2, a.buffer)
            // }
            return a
        },
        corr2(a1: number, a2: number, k1: any, k2: any) {
            const buffer = setting.bufferOn ? getBuffer(k1, k2) : null
            const l =  getBuffer2(k1, k2)
            l.ar1.push(a1)
            l.ar2.push(a2)
            checkSize(l.ar1)
            checkSize(l.ar2)
            // console.log(k1, k2)
            // map.forEach(e=> {e.forEach(z=>{
            //     console.log(z)
            // })})
            const a = CorrelationFunc(l.ar1, l.ar2, {rolling: setting.max, buffer})
            // if (setting.bufferOn && a.buffer) {
            //     map.get(k1)!.set(k2, a.buffer)
            // }
            return a
        }
    })
}


type tCorrBuffer = {
    sum1: number,
    sum2: number,
    step: number,
    pow1: number,
    pow2: number,
    last1: number,
    last2: number,
    first1: number,
    first2: number,
    mulSum: number
}

/**
 * Расчет потоковой корреляции
 * Rolling correlation
 * Для потоковости необходимо сохранять буфер
 *
 * @param d1 - первый массив
 * @param d2 - второй массив
 * @param setting - ....
 */
export function CorrelationFunc(d1: number[], d2: number[], setting: {rolling: number, endBar?: number, buffer: tCorrBuffer | null}): {corr: number, buffer?: tCorrBuffer} {
    const {min, pow, sqrt } = Math
    const {isNaN} = Number
    const {rolling} = setting
    const n = min(setting.endBar ?? d1.length, d2.length)
    if (n == 0)  return {corr: 0};
    const start = (rolling) ? (n-rolling>0? n-rolling: 0): 0;
    const end = n // start+n
    const c = n - start // count

    let step = (setting.buffer?.step ?? 0) // + c
    if (rolling && step > rolling) step = rolling

    const buffer = setting.buffer;
    const [end1,end2] = [d1[end-1],d2[end-1]]
    let [last1,last2] = [d1[start],d2[start]]



    let sum1,sum2,pow1,pow2,mulSum
    if (buffer && 1) {


        sum1 = buffer.sum1 - buffer.last1 + end1
        sum2 = buffer.sum2 - buffer.last2 + end2
        pow1 = buffer.pow1 - pow(buffer.last1,2) + pow(end1,2)
        pow2 = buffer.pow2 - pow(buffer.last2,2) + pow(end2,2)
        mulSum = buffer.mulSum - (buffer.last1 * buffer.last2) + (end1 * end2) //d1.map((n, i) => n * d2[i]).reduce(add)

        if (buffer.step < setting.rolling) {
            buffer.step++
            step++
            last1 = last2 = 0
        }

    }
    else {
        const add = (a: number, b: number) => a + b;
        const [_d1, _d2] = [d1.slice(start, end), d2.slice(start, end)]
        sum1 = _d1.reduce(add)
        sum2 = _d2.reduce(add)
        pow1 = _d1.reduce((a, b) => a + pow(b,2), 0)
        pow2 = _d2.reduce((a, b) => a + pow(b,2), 0)
        mulSum = _d1.map((r, i) => r * _d2[i]).reduce(add)
    }
    if (isNaN(sum1) || !sum1 ||
        isNaN(sum2) || !sum2 ||
        isNaN(last1)  ||
        isNaN(last2)  ||
        isNaN(mulSum) || !mulSum ||
        isNaN(pow2) || !pow2 ||
        isNaN(pow1) || !pow1) {
        console.log({sum1,sum2,last1,last2,mulSum,pow2,pow1});
        (async ()=>{throw "nanCor"})();
    }
    const dense = sqrt((pow1 - pow(sum1,2)/ c) * (pow2 - pow(sum2,2) / c))
    const buf: tCorrBuffer = {sum1, sum2, last1, last2, mulSum, pow2, pow1, step, first2: 0, first1: 0}
    if (buffer) Object.assign(buffer, buf)
    if (dense == 0) return  {corr: 0}; //, buffer: buf
    const result = (mulSum - (sum1 * sum2 / c)) / dense
    return {corr: result, buffer: buf};
}
