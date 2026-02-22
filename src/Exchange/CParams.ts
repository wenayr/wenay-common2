import {const_Date} from "../Common/core/BaseTypes";
import {deepCloneMutable, isDate} from "../Common/core/common";

type Digit= 0|1|2|3|4|5|6|7|8|9;

//type Year=  `${19|20}${Digit}${Digit}`
type Year = number;

//type Month= 1|2|3|4|5|6|7|8|9|10|11|12;
type Month= number;

//type Day= 1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31;
type Day= number;

//type Hour= 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23;
type Hour= number;

//type Minute= 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31|32|33|34|35|36|37|38|39|40|41|42|43|44|45|46|47|48|49|50|51|52|53|54|55|56|57|58|59;
type Minute= number;

type Second= Minute;

//type DateStr= /[12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/;
type DateStr = `${Year}-${Month}-${Day}`;// | `${Year}/${Month}/${Day}` | `${Year}.${Month}.${Day}`;
//type DateStr= `${number}-${number}-${number}`

type TimeStr_HHMM = `${Hour}:${Minute}`;

type TimeStr_HHMMSS = `${Hour}:${Minute}:${Second}`;

type TimeStr= TimeStr_HHMM | TimeStr_HHMMSS;

//export type DateTimeStr= DateStr | `${DateStr} ${TimeStr}`;  // почему-то приводит к ошибке компиляции
export type DateTimeStr= `${Year}-${Month}-${Day} ${Hour}:${Minute}`;

type DateTime = DateTimeStr | const_Date;

{
let ts : `${DateStr} ${TimeStr}` = "2025-06-01 16:25:25";
}
//[12]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01][0-9]|2[0-3]):[0-5]\d:[0-5]\d

// let rr :ReadonlyFull<DateTimeStr> = "" as DateTimeStr;
//
// let rr2 : DateTimeStr = "" as unknown as DateTimeStr;

export type RangeT<TVal, TStep=TVal> = {
    min: TVal;
    max: TVal;
    step: TStep;
}

export type RangeExtT<TVal, TStep> = RangeT<TVal, TStep> & {
    defaultMin: TVal;
    defaultMax: TVal;
    defaultStep: TStep;
}

export interface NumRange<T extends number = number> extends RangeT<T> {
    min: T;
    max: T;
    step: T;
}

export type NumRangeExt<T extends number> = RangeExtT<T,T>;


export type UserRangeT<TVal, TStep> = Partial<RangeExtT<TVal, TStep>> & ({min:TVal}|{defaultMin:TVal}) & ({max:TVal}|{defaultMax:TVal}) & ({step:TStep}|{defaultStep:TStep});

//export type UserNumRange<T extends number= number> = Partial<NumRangeExt<T>> & ({min:T}|{defaultMin:T}) & ({max:T}|{defaultMax:T}) & ({step:T}|{defaultStep:T});

export type UserNumRange<T extends number= number> = UserRangeT<T,T>;

type N<T extends number>= NumRangeExt<T>;

type UserNumRange2<T extends number=number, NumRange extends NumRangeExt<T> =NumRangeExt<T>> = Partial<NumRange> & (NumRange["min"]|NumRange["defaultMin"]) & (NumRange["max"]|NumRange["defaultMax"]) & (NumRange["step"]|NumRange["defaultStep"]);

//export type UserTimeRange = UserRangeT<DateStr, number>;
export type UserTimeRange = Partial<UserRangeT<DateTime, number>>;
//type UserTimeRange2= UserRangeT<DateStr, number>;
// type DDD = NumRangeExt["min"|"max"];
//
// let zzz : UserNumRange2<number> = { min: 1, max: 1, step: 1 }

//type P<T extends number, prop1 extends keyof NumRange, prop2 extends keyof NumRangeExt> = NumRange<T>[prop1] | NumRangeExt<T>[prop2];
//type MMM<T extends number> = Partial<NumRangeExt<T>> & P<T,"min","defaultMin"> & P<T,"max","defaultMax"> & P<T,"step","defaultStep">;


//type N<base, key1 extends keyof base, key2 extends keyof base> = base & ({key1:base[key1]}|{key2:base[key2]});
//type RES= N< N< N<Partial<NumRangeExt>,"min","defaultMin">, "max","defaultMax">, "step", "defaultStep">;



// type Mutable<T> = T extends object ? {
//     -readonly [P in keyof T]: T[P];
// } : T;

type Mutable<T> = { -readonly [P in keyof T]: T[P]; };

//type ReadonlyFullBase<T> = { readonly [P in keyof T] : ReadonlyFull<T[P]> }  //T[P] extends object ? ReadonlyFull<T[P]> : T[P] }

export type ReadonlyFull<T> =
    T extends ((...args:any)=>any) ? T
    : T extends const_Date ? const_Date
    : { readonly [P in keyof T] : ReadonlyFull<T[P]> };
//export type ReadonlyFull<T> = T extends ((...args:any)=>any) ? T : T extends object ? { readonly [P in keyof T] : ReadonlyFull<T[P]> } : T;
//export type ReadonlyFull<T> = T extends ((...args:any)=>any)|String ? T : T extends object ? { readonly [P in keyof T] : ReadonlyFull<T[P]> } : T;




type ParamType= "number"|"string"|"boolean"|"time"|"symbol";

//type XXX<T extends number|unknown= unknown> = { val :T extends number ? true : false };

//type Y =  XXX["val"];

export type AnyEnumVal= number|string|const_Date|object;

// Интерфейс параметра

interface IParamBase0 { //extends Readonly<{
    name? : string; // имя

    commentary?: string[],
    //value : string|number|boolean | (number|string|boolean)[] | IParams;  // значение по умолчанию
    range? : (number|string|DateTime|object)[] | UserNumRange | UserTimeRange | undefined;  // допустимый диапазон значений
    //defaultRange? : Partial<NumRange>|undefined; // допустимый диапазон значений
    progressive? : boolean|undefined;  // "прогрессивный" числовой параметр (значения можно перебирать по геометрической прогрессии)
    enabled? : boolean|undefined;  // включён ли параметр по умолчанию
    hidden? : boolean;  // скрытость параметра
    //constLength? :boolean|undefined;  // фиксированная длина массива
    type? :ParamType|undefined;
    //nonResizable? :boolean|undefined; // неизменяемый размер массива
} //> { }

interface IParamBase1<T = never> {
    value : string|number|boolean|DateTime|IParams | T | (number|string|boolean|DateTime|IParams|T)[];  // значение по умолчанию
    constLength? :boolean|undefined;  // фиксированная длина массива
    elementsEnabled? :boolean|undefined|(boolean[]);  // включён ли элемент массива по умолчанию
}

// export interface IParamBase extends Readonly<IParamBase0 & IParamBase1> {
// }
export interface IParamBase extends IParamBase0, IParamBase1 {
}

export type IParamBaseReadonly = ReadonlyFull<IParamBase>;
//console.log("!!!");

// interface IParamVal<TParam extends IParamBase0, T extends string|number|boolean|IParams> extends TParam, IParamBase {
//     value : T;
//     constLength? :undefined;
// }

interface IParamVal<T extends string|number|boolean|DateTime|IParams|object> extends IParamBase1<T> {
    value : T;
    constLength? :undefined;
    elementsEnabled? :undefined;
}
// interface IParamVal2<T extends string|number|boolean|DateTime> extends IParamBase1 {
//     value? : T;
//     constLength? :undefined;
//     type : T extends number ? "number" : T extends string ? "string" : T extends boolean ? "boolean" : "time";
// }

type ParamVal<TParam extends IParamBase0, T extends string|number|boolean|DateTime|IParams> = TParam & IParamVal<T>;

interface IParamArr<T extends string|number|boolean|DateTime|IParams> extends IParamBase1<T> {
    value : T[];
    constLength? :boolean;
    elementsEnabled? : boolean|(boolean[]); //T extends boolean ? undefined : boolean|(boolean[]);
}

type ParamArr<TParam extends IParamBase0, T extends string|number|boolean|DateTime|IParams> = TParam & IParamArr<T>;





//interface IParamBaseDefault<T extends number|string = number> extends IParamBase<T> {
interface IParamBaseDefault extends IParamBase0 {
    //validRange? : undefined;
    progressive? :undefined;
    //type? :undefined;
}


interface IParamNumBase<T extends number> extends IParamBase0 {
    //value : T;
    range : UserNumRange<T>;
    //validRange? : Partial<NumRange<T>>;
    progressive? :boolean;
    //enabled?:undefined;

    type? :"number"|undefined;
}

export type IParamNum<T extends number= number> = ParamVal<IParamNumBase<T>, T>;

export type IParamNumArr<T extends number= number> = ParamArr<IParamNumBase<T>, T>;

export type ParamNum<T extends number= number> = IParamNum<T> | IParamNumArr<T>;


interface _IParamEnumBase<T extends AnyEnumVal> extends IParamBaseDefault {
    range : T[]; //T[];
    //enabled?:undefined;
    labels? : string[] | undefined;
    valueToString? : {(value :T) : string} | undefined;
}

interface IParamEnumBaseAny1<T extends AnyEnumVal> extends _IParamEnumBase<T> { labels :string[];  valueToString? :undefined}
interface IParamEnumBaseAny2<T extends AnyEnumVal> extends _IParamEnumBase<T> { valueToString(value :T) :string;  labels? :undefined; }
type      IParamEnumBaseAny<T extends AnyEnumVal> = IParamEnumBaseAny1<T> | IParamEnumBaseAny2<T>;

interface IParamEnumBase<T extends number|string|DateTime> extends _IParamEnumBase<T>{
    labels? : string[];
    type? : T extends number ? "number" : "string"; //Extract<T,number> extends never ? (Extract<T,string> extends never ? never : "string") : "number";
    valueToString? :undefined;
}

export interface IParamEnum<T extends number|string|DateTime= number|string|DateTime> extends ParamVal<IParamEnumBase<T>, T> { }
export interface IParamEnum<T extends number|string|DateTime= number|string|DateTime> extends ParamVal<IParamEnumBase<T>, T> {
    // commentary?: string[];
}
export type IParamEnumReadonly<T extends number|string|DateTime= number|string|DateTime> = ReadonlyFull<IParamEnum<T>>;

export type IParamEnumAny<T extends AnyEnumVal = AnyEnumVal> = (T extends number|string|DateTime ? IParamEnumReadonly<T> : IParamEnumBaseAny<T>) & IParamVal<T>;

export interface IParamEnumArr<T extends number|string|DateTime= number|string|DateTime> extends ParamArr<IParamEnumBase<T>, T> { }

// export type ParamEnum<T extends number|string|DateTime = number|string|DateTime> = IParamEnum<T> | IParamEnumArr<T>;
export type ParamEnum<T extends number|string|DateTime = number|string|DateTime> =
    (IParamEnum<T> | IParamEnumArr<T>) //& { commentary?: string[] };
export type ParamEnumReadonly<T extends number|string|DateTime> = ReadonlyFull<ParamEnum<T>>;

interface IParamTimeBase1 extends IParamBaseDefault {
    range? : DateTimeStr[] | UserTimeRange; //T[];
    type :"time";
}
interface IParamTimeBase2 extends IParamBaseDefault {
    range? : const_Date[] | UserTimeRange; //T[];
    type? :"time";
}


export interface IParamTime1 extends ParamVal<IParamTimeBase1, DateTimeStr> { }
export interface IParamTime2 extends ParamVal<IParamTimeBase2, const_Date> {
}

export interface IParamTime1 extends ParamVal<IParamTimeBase1, DateTimeStr> {
}
export interface IParamTimeArr1 extends ParamArr<IParamTimeBase1, DateTimeStr> { }
export interface IParamTimeArr2 extends ParamArr<IParamTimeBase2, const_Date> { }
export interface IParamTimeArr2 extends ParamArr<IParamTimeBase2, const_Date> {
}
export type ParamTime= IParamTime1 | IParamTime2 | IParamTimeArr1 | IParamTimeArr2;


export interface IParamEnum2<T extends number|string> extends IParamBaseDefault {
    value : T|T[]; //TupleToUnion<TRange>; // extends number ? (number|number[]) : (string|string[]);
    range : [T,...T[]]; //[T, ...T[]];
    enabled? : undefined;
}

{ let x : IParamEnum2<5|6> = { value: 5, range : [5, 6] }; }

//type TupleToUnion<T extends [...unknown[]]> = T extends [number,...infer T2] ? (T[0] | TupleToUnion<T2>) : never;

// export interface IParamEnum2<TRange extends [...number[]]|[...string[]]> extends IParamBase {
//     value : TRange[number]; //TupleToUnion<TRange>; // extends number ? (number|number[]) : (string|string[]);
//     range : TRange; //[T, ...T[]];
//     progressive? : undefined;
//     enabled? : undefined;
// }
//let x : IParamEnum3<[5,6]> = { value: 5, range : [5, 6] };


// interface IParamString extends IParamEnum<string> {
// }
interface IParamStringBase extends IParamBaseDefault {
    range? :undefined;
    type? :"string"|"symbol";
}

interface IParamString extends ParamVal<IParamStringBase, string> { }

interface IParamStringArr extends ParamArr<IParamStringBase, string> { }

export type ParamString = (IParamString | IParamStringArr) // & { commentary?: string[] };


interface IParamBoolBase extends IParamBaseDefault {
    range? : undefined;
    enabled? : undefined;
    type? : "boolean";
}

export interface IParamBoolean extends ParamVal<IParamBoolBase, boolean> { }

export interface IParamBooleanArr extends ParamArr<IParamBoolBase, boolean> { constLength?: true }

export type ParamBoolean = (IParamBoolean | IParamBooleanArr) // & { commentary?: string[] };

export interface IParamGroup extends IParamBaseDefault, IParamBase1 {
    value: IParams;
    range? : undefined;
    enabled? : boolean;
    type? :undefined;
    constLength? :undefined;
    elementsEnabled? :undefined;
}



export type ParamBase<T extends "time"|number|string|boolean|object = "time"|number|string|boolean|object> =
    T extends "time" ? ParamTime :
    T extends string ? ParamEnum<T> :
    T extends number ? ParamNum<T>|ParamEnum<T> :
    T extends boolean ? ParamBoolean :
    T extends object ? IParamGroup : never;


type DD<T extends "aa"|number|string> = T extends "aa" ? "AA" : T extends string ? "SS" : "NN";

let dd! : DD<"aab"|number>;


//export type IParam2 = (IParamNum|IParamString|IParamBoolean|boolean|IParamGroup) & {[key in keyof IParamBase] : any};

export type IParam = ParamTime | ParamNum | ParamEnum<number> | ParamEnum<string> | ParamBoolean | ParamString | boolean | number | string | IParamGroup | (()=>any); // & {[key in "name"|"value"|"range"|"enabled"] : any};

type IParamExt<T> = T extends IParamNum|IParamEnum<string>|IParamBoolean|boolean|IParamGroup|(()=>any) ? T : T extends IParamEnum2<infer TRange> ? T : never;

export type IParamReadonly = ReadonlyFull<IParam>

///// @ts-ignore
export function isParamBase(param :IParam) : param is IParam&IParamBase;
// // @ts-ignore
// export function isParamBase(param :IParamReadonly) : param is IParamBaseReadonly;

export function isParamBase<T extends IParamReadonly> (param :T) {
    return typeof param=="object" && !Array.isArray(param) && !(param instanceof Date); //isDate(param); //
}


//let timeParam : IParamTime = { value : "2020-01-01 15:26", type: "time", range : ["2020-01-01 15:26"] };

// Интерфейс группы параметров
export type IParams= {
    [key in string]: IParam;
}

type IParams2<T extends IParams =any>= {
    [key in keyof T]: IParamExt<T[key]>;
}


export type IParamsReadonly = { //= ReadonlyFull<IParams>
    readonly [key in string]: IParamReadonly;
}


export class CParams implements IParams {
    [key :string] : IParam;// & {[key in keyof { name?:any, value:any, range?:any, enabled?:any }] : any};
}

export class CParamsReadonly implements IParamsReadonly {
    readonly [key :string] : IParamReadonly;// & {[key in keyof { name?:any, value:any, range?:any, enabled?:any }] : any};
}


export type IParamExpandable= Exclude<IParam,{value :any}> | (Extract<IParam, {value :any}> & { expanded?: boolean }); //Exclude<IParam,IParamGroup|IParamArr<any>> | (IParamGroup & {expanded?: boolean}) | (Extract<IParam, IParamArr<any>> & {expanded?: boolean});

export type IParamExpandableReadonly = ReadonlyFull<IParamExpandable>;

export type IParamsExpandable = { [key :string] : IParamExpandable };

export type IParamsExpandableReadonly = ReadonlyFull<IParamsExpandable>;

export function isParamGroupOrArray<TParam extends IParamReadonly>(param :TParam) : param is Extract<TParam,ReadonlyFull<IParamGroup|IParamArr<any>>> {
    return typeof param=="object" && typeof param.value=="object" && !(param.value instanceof Date);//(param.value instanceof Array || (param.value as unknown as IParamBase).value!=null);
}

export function isParamGroup<TParam extends IParamReadonly>(param :TParam) : param is Extract<TParam,ReadonlyFull<IParamGroup>> {
    return isParamGroupOrArray(param) && !Array.isArray(param.value);
}

export function isSimpleParams2<TParams extends IParamsReadonly>(params: TParams | SimpleParams) {
    let t = false
    for (let key in params) {
        const tr = (params[key] as any)["value"] as any
        if (!tr) return true;
        else {
            if (typeof tr == "object") {
                const r = isSimpleParams(tr)
                if (r) return true;
            }
        }
    }
    return false
}
export function isSimpleParams<TParams extends IParamsReadonly>(params: TParams | SimpleParams) {
    for (let key in params) {
        const param = params[key] as any;
        // Если это примитив или null — это простой параметр
        if (param == null || typeof param !== "object") {
            return true;
        }
        // Если у объекта нет свойства "value" — это простой параметр
        if (!("value" in param)) {
            return true;
        }
        // Если value — объект (но не Date и не Array), рекурсивно проверяем
        const val = param.value;
        if (typeof val === "object" && val !== null && !(val instanceof Date) && !Array.isArray(val)) {
            const r = isSimpleParams(val);
            if (r) return true;
        }
    }
    return false;
}
type ObjectKeyPath<TObject extends object=object, TValue=unknown> = readonly string[];

export function* iterateParams<TObj extends IParamsReadonly, TVal extends IParamReadonly= TObj[string]>
    (obj :TObj, currentPath : ObjectKeyPath<TObj,TVal> = []) : Generator<[key :string, value :TVal, path :ObjectKeyPath<TObj, TVal>]> {
        for(let [key,param] of Object.entries(obj)) {
            let keyPath= currentPath.concat(key);
            yield [key, param as TVal, keyPath];
            if (typeof param=="object") {
                const valKey= "value";
                let value = (param as IParamBase)[valKey]; // .value;
                if (typeof value=="object" && !isDate(value) && !Array.isArray(value))
                    yield *iterateParams(value, keyPath.concat(valKey));
            }
        }
}

// создаёт копию параметров со всеми включёнными/выключенными параметрами (enabled= true/false)

export function enableAllParams<T extends IParamsReadonly> (params :T, enabled=true) {
    const paramsInfoClone= deepCloneMutable(params) as IParams;
    for(let [key,param] of iterateParams(paramsInfoClone)) {
        if (isParamBase(param) && param.enabled !=null) param.enabled= enabled;
        if (isParamBase(param) && param.elementsEnabled !=null) param.elementsEnabled= enabled;
    }
    return paramsInfoClone as T;
}

// let a! : IParamExpandable;
// if (typeof a=="object")
//     if (typeof a.value)

// function _paramsInfoToExt(params :IParamsReadonly) {
//     let obj= new class extends CParams {lastBar= { name: "Last_Bar", value: 0, range: { defaultMin:-10000, max:0, step:1 } }; }();
//     return Object.assign(obj, {...params});
// }
//
// type ParamsReadonlyExt = ReadonlyFull<ReturnType<typeof _paramsInfoToExt>>;
//
// function paramsInfoToExt(params :IParamsReadonly) { return params as ParamsReadonlyExt; }//return (params as ParamsReadonlyExt).lastBar!=undefined ? params as ParamsReadonlyExt : _paramsInfoToExt(params); }
//
//
// let aaa! : IParamsReadonly;
//
// type IParam2 = ParamTime | ParamNum | ParamEnum<number> | ParamEnum<string> | ParamBoolean | boolean | number | IParamGroup | (()=>any); // & {[key in "name"|"value"|"range"|"enabled"] : any};
//
// //type IParam2= ParamNum;// | IParamGroup;// | (()=>any);
//
// export type IParams2_= {
//     [key in string]: IParam2;
// }
//
// export class CParams2 implements IParams2_ {
//     [key :string] : IParam2;// & {[key in keyof { name?:any, value:any, range?:any, enabled?:any }] : any};
// }

class C extends CParams { lastBar = { name: "Last_Bar", value: 0, range: { defaultMin:-10000, max:0, step:1 } }; }

type IParamsReadonly2= { readonly [key in string]: ReadonlyFull<IParam> }

let xxx= {} as ReadonlyFull<C & IParamsReadonly2>;
//xxx["lastBar"]= xxx["lastBar"];

let bbb :IParamsReadonly2 = xxx; //paramsInfoToExt(aaa);

// export class CParams2<T> { // <T extends {[key in keyof T] : IParamEnum2<any>}> {//implements III2<T[keyof T]> {// & IParamEnum2<T[key]["range"]>} = any>  {
//     [key : string] : T[keyof T] extends {readonly range : [...number[]]|[...string[]]} ? IParamEnum3<T[keyof T]["range"][number]> : T[keyof T]; //IParamEnum2<any>; //IParamExt<T>;// & {[key in keyof { name?:any, value:any, range?:any, enabled?:any }] : any};
// }
//
// class ZParams extends CParams2<ZParams> {
//     param = {value: 15, range: [10, 20] as const} as const;//, name: "param1"};
//     //param2 = {value: 15, range: [100, 200], name: "param2"};
// }




// Пример
const param : IParams= {
    p0 : {name: "MA0", value: [10, 20], range: [10, 20 ,30] },
    p1 : {name: "MA1", commentary:["fgf"], value: 20, range: {min: 10, max: 20, step: 2} },
    p2 : {name: "MA2", value: 10, range: [10, 20, 30] },
    p3 : {name: "MA3", value: "a", range: ["a", "b", "c"] },
    p4 : {name: "MA4", value: true },
    p5 : {
        name : "group",
        commentary: ["group for... "],
        enabled : true,
        value:{
            p1 : {name: "gMA1", value: 20, range: {min: 10, max: 20, step: 2} },
            p2 : {name: "gMA2", value: 10, range: [10, 20, 30] }
        }
    },
    p6 : 10,
    p7 : { name: "time", value : "2020-01-05 12:46", type: "time", range: {min: "2020-01-05 00:00", max: "2020-01-05 00:00", step: 200 } },
    p8 : { name: "time2", value: new Date()}

    //wrongParam :0
}


class CCC extends CParams
{
    time = { name: "Time", value: "2020-01-05 12:46", type : "time" } as const;
    text= { value: "text", type: "symbol"} as const;
}

//let aaa : IParam = { value: "text", type: "symbol" };// as const;

class Test2 {
    //[param :string] : IParam2;
    p0 = 123;
    p1 = "213";
    p2 = [10, 20, 30];
    p3 =  "a";
    p4 = true;
    p5 = {
        enabled : true,
        p1 : "gMA1",
        p2 : "gMA2"
        }
    }


//class Test implements IParams {
class Test extends CParams {
    //[param :string] : IParam2;
    p0 = {name: "MA0", value: [10, 20], range: [10, 20 ,30] };
    p1 = {name: "MA1", value: 20, range: {min: 10, max: 20, step: 2} };
    p2 = {name: "MA2", value: 10, range: [10, 20, 30] };
    p3 = {name: "MA3", value: "a", range: ["a", "b", "c"] };
    p4 = {name: "MA4", value: true, commentary: ["Dsd"] };
    p5 = {
        name : "group",
        enabled : true,
        value:{
            p1 : {name: "gMA1", value: 20, range: {min: 10, max: 20, step: 2} },
            p2 : {name: "gMA2", value: 10 ,range: [10, 20, 30] }
        }
    }
}
// так не стоит делать
function TestFunction() {
    return {
        //[param :string] : IParam2;
        p0: {name: "MA0", value: [10, 20], range: [10, 20 ,30] },
        p1: {name: "MA1", value: 20, range: {min: 10, max: 20, step: 2} },
        p2: {name: "MA2", value: 10, range: [10, 20, 30] },
        p3: {name: "MA3", value: "a", range: ["a", "b", "c"] },
        p4: {name: "MA4", value: true, commentary: ["Dsd"] },
        p5: {
            name : "group",
            enabled : true,
            value:{
                p1 : {name: "gMA1", value: 20, range: {min: 10, max: 20, step: 2} },
                p2 : {name: "gMA2", value: 10 ,range: [10, 20, 30] }
            }
        }
    } satisfies CParams
}





//type SimpleT<T> = { [key in keyof T] : (T[key] extends {value :any} ? T[key]["value"] : T[key] extends {group :any; } ? SimpleT<T[key]["group"]> : T[key]) }
export type SimpleParamsMutable<T> = //<T extends IParamsReadonly> =
    T extends const_Date ? const_Date
    : Mutable<{
        [key in keyof T] :
            // T[key] extends (...args:any)=>any
            // ? T[key] :
            //T[key] extends const_Date ? const_Date :
                (T[key] extends {value :IParamsReadonly}
                    ? SimpleParamsMutable<T[key]["value"]>
                    : T[key] extends {value :any}
                        ? (T[key] extends {value: [], elementsEnabled :boolean|[]} ? Partial<Mutable<T[key]["value"]>> : Mutable<T[key]["value"]>)
                        : T[key] extends ()=>infer RES
                            ? RES
                            : Mutable<T[key]>
                ) | (T[key] extends {enabled: boolean} ? null : never)
    }> & { readonly [key : number]: void; }
//export type SimpleParamsMutable<T> = Mutable<{ [key in keyof T] : (T[key] extends {value :IParams} ? SimpleParamsMutable<T[key]["value"]> : T[key] extends {value :any} ? Mutable<T[key]["value"]> : Mutable<T[key]>) | (T[key] extends {enabled: boolean} ? null : never) }> & { readonly [key : number]: void; }


//let aaa! : SimpleParamsMutable<{fff(a :number) :void}>
//aaa.fff(0);

export type SimpleParams<T=IParams> = ReadonlyFull<SimpleParamsMutable<T>>;

//export type SimpleParams<T> = SimpleParamsMutable<T>;



export function GetSimpleParams<T extends ReadonlyFull<IParams>>(params : T) //: SimpleT<T>
    {
    //if (!params) return null;
    const simpleParamsBase= params instanceof Array ? [] : {};
    let simpleParams = simpleParamsBase as  typeof simpleParamsBase & {[key : string] : any};
    //function arrayFilter<T>(arr :T[], f) { return arr.filter()}
    for(let key in params) {
        const param : IParamReadonly = params[key];// as IParamReadonly;
        simpleParams[key]=
            typeof(param) =="function" ? param() :
            typeof(param) !="object" ? param :
            param == null ? null :
            //typeof(param)=="boolean" ? param :
            param.enabled==false ? null :
            typeof(param.value) !="object" ? param.value :
            param.value instanceof Array ? (
                (param.value as any[]).filter((item, i)=> Array.isArray(param.elementsEnabled) ? param.elementsEnabled[i] : param.elementsEnabled!=false)
            ) :
            param.value instanceof Date ? new Date(param.value) :
            //param.value instanceof Array ? [...param.value] :
            GetSimpleParams((param as IParamGroup).value);
            //GetSimpleParams((param as IParamGroup).enabled!=false ? (param as IParamGroup).value : null);

    }
    return simpleParams as SimpleParamsMutable<T>;
}

let p= GetSimpleParams(new Test());

let p0 : number = p.p1;

let p3 : string = p.p3;

let p4 : boolean= p.p4;

let p5 : number|undefined = p.p5?.p1;

//let p6 : number = p.p5.p1; // пример ошибки

function convert_(valuesObj :{[key :string] :any}, srcObj : IParamsReadonly | readonly any[]) {
    let resObj : {[key :string] :IParamReadonly} = {};
    if (srcObj instanceof Array)
        if (valuesObj instanceof Array) return [...valuesObj];
        else return srcObj;
    for(let key in srcObj as IParamsReadonly) {
        const srcval : IParamReadonly = srcObj[key]; //let aaa= resObj[key];
        resObj[key]= (()=> {
            const val= valuesObj[key];// as SimpleParams<IParamReadonly>;
            if (val==undefined) {
                if (typeof srcval=="object" && (srcval as IParamBase).enabled!=undefined)
                    return {...srcval, enabled: false } as IParamReadonly;
            }
            if (typeof srcval=="boolean") {
                if (typeof val=="boolean")
                    return val;
            }
            if (typeof srcval=="object") {
                let srcvalue= srcval.value;
                if (srcvalue==null) return srcval;
                const resVal= {...srcval} as Mutable<typeof srcval>; //, enabled: true};
                if (srcvalue instanceof Date && (typeof val=="string" || val instanceof Date))
                    resVal.value = new Date(val);
                else
                if (typeof srcvalue!=typeof val) return srcval;
                else
                if (typeof srcvalue!="object")
                    resVal.value= val;
                else
                if (Array.isArray(val)) { resVal.value= [...val as []]; if (resVal.elementsEnabled!=null) resVal.elementsEnabled=true; }
                else resVal.value= convert_(val, srcvalue);
                if ((srcval as IParamBase).enabled!=undefined)
                    resVal.enabled= true;
                return resVal;
            }
            return srcval;
        })();
    }
    return resObj;
}
// let a : Readonly<{ val: number }> = {val: 20};
//
// class zzz<out T> { }
//
// let b= {...a};
// b.val= 10;

//a.val= 20;

// type Colors = "red" | "green" | "blue";
// type RGB = [red: number, green: number, blue: number];
// const palette = {
//     red: [255, 0, 0],
//     green: "#00ff00",
//     bleu: [0, 0, 255]
// //  ~~~~ The typo is now caught!
// } satisfies Record<Colors, string | RGB>;

// слияние значений параметров

export function mergeParamValuesToInfos<TParams extends IParamsReadonly, TParams2 extends IParamsReadonly> (srcObj :TParams, valuesObj :SimpleParams<TParams2>|TParams2) {

    return convert_(isSimpleParams(valuesObj) ? valuesObj : GetSimpleParams(valuesObj as IParams), srcObj) as TParams;
}

function test(){
    {
        const p = new Test()

        const s = GetSimpleParams(p)
        const r = mergeParamValuesToInfos(p, s)
        console.log(p, s, r)
    }
    {
        // const p = TestFunction()
        //
        // const s = GetSimpleParams(p)
        // const r = mergeParamValuesToInfos(p, s) // Error
        // console.log(p, s, r)
    }
}
// test()

//
// function GetSimpleParams2<T extends IParams>(params : T) //: SimpleT<T>
// {
//     if (!params) return null;
//     let simpleParams : {[key : string] : any;} = {};
//     {Object.entries(params).map((data:[string,IParams])=>
//
//     for(let key in params) {
//         let param= params[key];
//         simpleParams[key]= param.value!=null ? param.value : typeof(param)!="object" ? param : GetSimpleParams(param.enabled!=false ? param.group : null);
//     }
//     return simpleParams as SimpleT<T>;
// }
//
//
// let p= GetSimpleParams(new Test);
//
// let p0 : number = p.p1;
//
// let p3 : string = p.p3;
//
// let p4 : boolean= p.p4;
//
// let p5 : number = p.p5.p1;