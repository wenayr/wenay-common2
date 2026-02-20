import type {AxiosStatic} from "axios/index";
// import {IBorrowable} from "../interfaces";
// import {GetSignatureFunc} from "../signatureCoder";

export type tFtt = {apiKey: string, axios: AxiosStatic, apiSecret: string}

export const binanceHeader = (apiKey: string) => ({headers: {'Content-type': 'application/x-www-form-urlencoded', 'X-MBX-APIKEY': apiKey}})

export type tFF =  {type: "IP" | "UID" | string, wight: number, timeMs: number, max: number}

export type standard<T extends (...args: any)=> any> = {
    wight: tFF | tFF[],
    function: T //((...args: any)=> unknown)
} //| T

// type tMaxBorrowableCrossF = (asset: string)=>Promise<IBorrowable>
type tSimpleFunc = (...arg: any) => any
export type tSimpleFunc2<T> = (arg: T) =>  (standard<tSimpleFunc>) //(testT<tSimpleFunc>| tSimpleFunc)
export abstract class aBinanceDataFunc {
    [ket: string]: tSimpleFunc2<tFtt>
}

