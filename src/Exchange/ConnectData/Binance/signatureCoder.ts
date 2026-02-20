// шифрование
// import {createHmac} from "node:crypto";
//
import * as createHmac from 'create-hmac'
// var createHmac = require('create-hmac')
export type MilliSec = number
type tInputBaseR = {
    [key:string] : boolean | number | string | string[]
}

export type tInputBase = {
    timestamp?: MilliSec
    recvWindow?: MilliSec
} & tInputBaseR

// type tSignatureDateBase =  {
//     recvWindow?: number | 5000,
//     timestamp: number
// } & tInputBase

type tSignatureDate =  tInputBase
export function getSignatureFuncF(data: {createHmac: any}) {
    return function (q:tSignatureDate, apiSecret: string) {
        
        const query = Object.keys(q)
            .reduce((a: string[], k) => {
                const o = q[k]
                if (Array.isArray(o)) {
                    o.forEach(v => {
                        a.push(k + "=" + encodeURIComponent(v))
                    })
                } else if (o !== undefined) {
                    a.push(k + "=" + encodeURIComponent(o));
                }
                return a;
            }, [])
            .join("&");
        // console.log(query);
        return data.createHmac('sha256', apiSecret).update(query).digest('hex') as string
    }
}

// export const GetSignatureFunc = getSignatureFuncF({createHmac})
export type tGetSignatureFunc = ReturnType<typeof getSignatureFuncF>