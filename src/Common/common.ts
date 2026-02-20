/////?<reference path="./BaseTypes.d.ts" />

//import 'source-map-support/register'
//if (0) console.log();
//import 'source-map-support/register.js';
/*
    import sourceMapSupport from 'source-map-support'
    sourceMapSupport.install({
        hookRequire: true,
        //handleUncaughtExceptions: true
        environment: 'node'
    });
*/
//declare function require(name: string);
//require('source-map-support').install();
//"module" : "ES6"

//-r source-map-support/register
//--loader ts-node/esm.mjs

//"sourceMap": true,


//
//import SourceMapIndexGenerator from 'source-map-index-generator';
//SourceMapIndexGenerator.install();

import {Immutable, KeysWithoutType, Mutable, MutableFull, PickTypes, ReadonlyFull} from "./BaseTypes";

import "./node_console"
//import "./Time";

export function GetEnumKeys<TT extends {[key:string]:any}> (T :TT) : readonly (keyof typeof T)[] { return Object.keys(T).filter(k => isNaN(k as any)); }

//import type {ParsedUrlQuery, ParseOptions, StringifyOptions} from "./querystringMy";
//import type {ByteStreamW} from "./ByteStream";
//import type {const_Date} from "./Time";

type const_Date= Omit<Date, "setTime"|"setFullYear"|"setMonth"|"setDate"|"setHours"|"setMinutes"|"setSeconds"|"setMilliseconds"|"setUTCFullYear"|"setUTCMonth"|"setUTCDate"|"setUTCHours"|"setUTCMinutes"|"setUTCSeconds"|"setUTCMilliseconds">;

// console.log(123)
// new HTMLElement()
// top;
// global.name;
// global.window
// name;

//export function is_const_Date<T extends any & (const_Date extends T ? T : never)> (value :T) : value is const_Date { return value instanceof Date; }


export function isDate<T> (value :T & (Extract<T,const_Date> extends never ? never :T))
: value is Extract<typeof value,const_Date>
{
    return value instanceof Date;
}
// проверка
{
    let aaa! : number;//|const_Date;
    //is_const_Date(aaa);  // ошибка

    let bbb! : number|const_Date;
    if (isDate(bbb))
        bbb.getDate();

    let ccc! : number|Date;
    if (isDate(ccc))
        ccc.getDate();
}



if (0)
Object.prototype.valueOf= function(this) {
	//if (this.constructor.name=="CallSite") undefined as unknown as object;
	console.error("function 'valueOf' is not defined in object",this.constructor.name,":",this);
	throw new Error("function 'valueOf' is not defined!!!");
}

//delete Object.valueOf;

// Проверка ошибки:

// class A { val; private valueOfs() { return this.val; }  constructor(value) { this.val= value; } }
// console.log(new A(1) > new A(0));

//export type Mutable<T> = T extends object ? { -readonly [P in keyof T]: T[P]; } : T;

//export type Mutable<T> = { -readonly [P in keyof T]: T[P]; };
export {Mutable}

//export type MutableFull<T> = T extends Function ? T : { -readonly [P in keyof T] : MutableFull<T[P]> } //T[P] extends object ? ReadonlyFull<T[P]> : T[P] }



export function shallowClone<T>(val :T) : Mutable<T> {
	return Array.isArray(val) ? Object.assign([], {...val}) // as unknown as T
	: typeof val=="object" && val ? {...val} : val;
}

// Глубокое клонирование любого типа

export function _deepClone<T>(src :T, map? :Map<object,object>) {
	if (!src || typeof src!="object") return src;
    //function createObjectOfType
	let newobject : { [key: string]:any; } = src instanceof Array ? [] : { }
	if (src instanceof Set) newobject= new Set(src.values()); else
	if (src instanceof Map) newobject= new Map(src.entries()); else { }
	if (src instanceof Date) newobject= new Date(src);
    let first=true;
    function getMap() {
        map??=new Map();
        if (first) { map.set(src as unknown as object, newobject);  first=false; }
        return map;
    }
    function mapGetOrSet(key :object, valFunc :()=>object) { let val= map?.get(key);  if (!val) getMap().set(key, val=valFunc());  return val; }
	for(let [key,value] of Object.entries(src)) {
		newobject[key] =
			typeof(value)=="object"
				? mapGetOrSet(value, ()=>_deepClone(value, map))
				: typeof(value)=="function"
					? value.bind(newobject)
					: value;
	}
	return newobject as { [key in keyof T] : T[key] };
}

export function deepClone<T>(object :T) { return _deepClone(object); }

export function deepCloneMutable<T>(value :T) { return deepClone(value) as MutableFull<T>; }


// let aaa= { val: { x: 10, y : { z: {} } } };//, a: {}} };
// aaa.val.y.z= aaa.val;
// //aaa.a= aaa;
// let bbb= deepClone(aaa);
// console.log(bbb);

// Глубокое клонирование объекта

export function deepCloneObject<T extends object>(object :T) {
	if (object==undefined) throw new Error("object is undefined!"); //return {};
	return deepClone(object);
}

export function deepCloneObjectMutable<T extends object>(object :T) { return deepCloneObject(object) as MutableFull<T> }


export function toImmutable<T extends object>(object :T) : Immutable<T> {
	return (object as Immutable<any>).Mutable==false ? object as Immutable<T>
		: Object.freeze(Object.assign(deepCloneObject(object), {Mutable: false})) as Immutable<T>;
}


export function readonlyFull<T>(arg :T) { return arg as ReadonlyFull<T>; }




// глубокое сравнение структур
export function deepEqual<T extends { [key: string]: any }>(object1: T, object2: T) {//}, equalityComparer? :(a :any, b :any)=>boolean|undefined) {
    if (object1==object2) return true;
    // if (typeof object1!=typeof object2) return false;
    // if (typeof object1!="object") return object1===object2;
    // console.log(typeof object1, typeof object2,  object1!=null, object2!=null);
    const keys1 = Object.keys(object1);
    const keys2 = Object.keys(object2);

    if (keys1.length != keys2.length) return false;

    for (const key of keys1) {
        const val1 = object1[key];
        const val2 = object2[key];
        if (val1===val2) continue;
        // if (equalityComparer)
        //     if (equalityComparer?.(val1, val2)==true) continue;
        const areObjects = typeof(val1)=="object" && typeof(val2)=="object" && val1!=null && val2!=null;
        //if (areObjects ? !deepEqual(val1, val2) : val1 !== val2)
        if (!areObjects || !deepEqual(val1, val2))
            return false;
    }
    return true;
}

// сравнение структур неглубокое
export function shallowEqual<T extends { [key: string]: unknown }|undefined>(object1: T, object2: T) {
	if (!object1 || !object2) return object1==object2;
	const keys1 = Object.keys(object1);
	const keys2 = Object.keys(object2);

	if (keys1.length != keys2.length) {
		return false;
	}
	for (const key of keys1) {
		const val1 = object1[key];
		const val2 = object2[key];
		if (val1 !== val2)
			return false;
	}
	return true;
}

// сравнение массивов неглубокое
export function arrayShallowEqual<T extends unknown>(arr1 :readonly T[], arr2 :readonly T[]) : boolean
{
    if (arr1.length != arr2.length) return false;
    return arr1.every((item,i) => arr2[i]==item);
}



export async function sleepAsync(msec :number=0) {
	return new Promise((resolve, reject) => { setTimeout(resolve, msec); });
}


export class CBase { readonly [key :number] : void; }//protected valueOf() { } }



export enum E_SORTMODE { DESCEND, ASCEND};

export enum E_MATCH { LESS_OR_EQUAL=-1, EQUAL, GREAT_OR_EQUAL }

export type SearchMatchMode = E_MATCH | "lessOrEqual"|"equal"|"greatOrEqual";

export type SortMode = E_SORTMODE|"ascend"|"descend";


// Бинарный поиск  BSearch(array, value, match, sortMode)
export function BSearch<T extends {valueOf():number}> (array :ArrayLike<T>,  value :T,  match? :SearchMatchMode,  mode? :SortMode) : number;

// Бинарный поиск  BSearch(array, value, comparer, match, sortMode)
export function BSearch<T,T2>(array :ArrayLike<T>,  value :T2,  comparer : (a:T, b:T2)=>number,  match? :SearchMatchMode,  mode? :SortMode) : number;

// Бинарный поиск  BSearch(array, itemComparer, match, sortMode)
export function BSearch<T>(array :ArrayLike<T>, compareElement : (item:T)=>number,  match? :SearchMatchMode,  mode? :SortMode) : number;
/**
 * Бинарный поиск: <br>
 * BSearch(array, value, match, sortMode)  или <br>
 * BSearch(array, value, comparer, match, sortMode)
 */
export function BSearch<T>(array :ArrayLike<T>,  arg2 :any,  arg3? :any, ...args : any) : number {
	return typeof(arg3)=="function" ? __BSearch(array, arg2, arg3, ...args) :
		typeof(arg2)=="function" ? ___BSearch(array, arg2, arg3, ...args) :
		BSearchDefault(array as any[], arg2, arg3, ...args);
}


// Бинарный поиск по внешнему упорядоченному массиву BSearchAsync(length: number,  compareIndexToValue : (index: number)=>Promise<number>,  matchMode? :SearchMatchMode,  sortMode? :SortMode)
export const BSearchAsync: typeof ___BSearchAsync = (...a) => ___BSearchAsync(...a)


// Бинарный поиск  BSearchDefault(array, value, match, mode)
//
export function BSearchDefault<T extends {valueOf():number}> (array :ArrayLike<T>,  value :T,  match? :SearchMatchMode,  mode? :SortMode) : number
{
	return __BSearch(array, value, (a, b)=> Math.sign(a.valueOf()-b.valueOf()),  match, mode);
}

// Бинарный поиск  BSearch(array, comparer1, match, mode)

function __BSearch<T,T2>(array :ArrayLike<T>,  value :T2,  comparer : (a:T, b:T2)=>number,  matchMode? :SearchMatchMode,  sortMode? :SortMode) : number
{
	return ___BSearch(array, (item)=>comparer(item, value), matchMode, sortMode);
}

// Бинарный асинхронный поиск по внешнему массиву данных  BSearch(array, value, comparer2, match, mode)
//
async function ___BSearchAsync(length: number,  compareIndexToValue : (index: number)=>Promise<number>,  matchMode? :SearchMatchMode,  sortMode? :SortMode) : Promise<number>
{
	if (sortMode==undefined) sortMode= E_SORTMODE.ASCEND;
	let k= (sortMode===E_SORTMODE.DESCEND || sortMode=="descend" ? -1 : sortMode===E_SORTMODE.ASCEND || sortMode=="ascend" ? 1 : (()=>{throw new Error("wrong sortMode: "+JSON.stringify(sortMode))})());
	let match= typeof matchMode !="string" ? matchMode : matchMode=="equal" ? E_MATCH.EQUAL : matchMode=="lessOrEqual" ? E_MATCH.LESS_OR_EQUAL : matchMode=="greatOrEqual" ? E_MATCH.GREAT_OR_EQUAL : (()=>{throw new Error("wrong matchMode!")})();
	let start = 0;
	let count= length;
	let end= start+count-1;
	let left= start;
	let right= end;
	let i= left;
	while (left<=right)
	{
		i= (left + right)>>1;
		let cmp= await compareIndexToValue(i) * k;
		if (cmp>0) { right=i-1;  continue; }
		if (cmp<0) { left=i+1;  continue; }
		return i;
	}
	if (match==E_MATCH.LESS_OR_EQUAL)  { i=right;  if (i<start) i=-1; }   // if (i < start) i=-1; }
	else if (match==E_MATCH.GREAT_OR_EQUAL) { i=left;  if (i>end) i=-1; }  //  if (i > end) i=-1; }
	else i=-1;
	return i;
}

// Бинарный синхронный поиск по внешнему массиву данных: BSearchIndex(length, comparer, match, sortMode)
//
export function BSearchIndex(length: number,  compareIndex : (index: number)=>number, matchMode? :SearchMatchMode, sortMode? :SortMode) : number
{
	if (sortMode==undefined) sortMode= E_SORTMODE.ASCEND;
	let k= (sortMode===E_SORTMODE.DESCEND || sortMode=="descend" ? -1 : sortMode===E_SORTMODE.ASCEND || sortMode=="ascend" ? 1 : (()=>{throw new Error("wrong sortMode: "+JSON.stringify(sortMode))})());
	let match= typeof matchMode !="string" ? matchMode : matchMode=="equal" ? E_MATCH.EQUAL : matchMode=="lessOrEqual" ? E_MATCH.LESS_OR_EQUAL : matchMode=="greatOrEqual" ? E_MATCH.GREAT_OR_EQUAL : (()=>{throw new Error("wrong matchMode!")})();
	let start = 0;
	let count= length;
	let end= start+count-1;
	let left= start;
	let right= end;
	let i= left;
	while (left<=right)
	{
		i= (left + right)>>1;
		let cmp= compareIndex(i) * k;
		if (cmp>0) { right=i-1;  continue; }
		if (cmp<0) { left=i+1;  continue; }
		return i;
	}
	if (match==E_MATCH.LESS_OR_EQUAL)  { i=right;  if (i<start) i=-1; }   // if (i < start) i=-1; }
	else if (match==E_MATCH.GREAT_OR_EQUAL) { i=left;  if (i>end) i=-1; }  //  if (i > end) i=-1; }
	else i=-1;
	return i;
}


function ___BSearch<T>(array :ArrayLike<T>,  compareItemToValue : (item:T)=>number,  matchMode? :SearchMatchMode,  sortMode? :SortMode) : number
{
    return BSearchIndex(array.length, (i)=>compareItemToValue(array[i]), matchMode, sortMode);
}

/** Binary search of value in range (from, to) with precision (float number)
*/
export function BSearchValueInRange(from: number, to: number, precision : number, compare : (val: number)=>number, matchMode :SearchMatchMode) : number|null {
    //if (from > 0) throw new Error(`BSearchVal: from > to : ${from} > ${to}`);
    if (precision==0) throw new Error("precision=0");
    let count= Math.round((to - from)/precision)+1;
    const sortMode= count>=0 ? 1 : -1;
    count= Math.abs(count);
    let i= BSearchIndex(count, (index)=>compare(from + precision * index),  matchMode);
    if (i==-1) return null;
    return from + precision * i;
}

BSearch.EQUAL= E_MATCH.EQUAL;
BSearch.LESS_OR_EQUAL= E_MATCH.LESS_OR_EQUAL;
BSearch.GREAT_OR_EQUAL= E_MATCH.GREAT_OR_EQUAL;


/** найти элемент с ближайшим значением*/
export function BSearchNearest(array :ArrayLike<number>, searchValue :number, maxDelta? :number) : number;
/** найти элемент с ближайшим значением*/
export function BSearchNearest<T>(array :ArrayLike<T>, searchValue :number, arrayGetValue :(element :T)=>number, maxDelta? :number) : number;
/** найти элемент с ближайшим значением*/
export function BSearchNearest<T>(array :ArrayLike<T>, searchValue :number, getterOrDelta? : ((element :T)=>number)|number, maxDeltaOrNull? :number) {
    let [getter, maxDelta] = typeof getterOrDelta=="function" ? [getterOrDelta,maxDeltaOrNull] : [(elem :any)=>elem as number, getterOrDelta];
    return _BSearchNearest(array, searchValue, getter, maxDelta);
}

// найти элемент с ближайшим значением
export function _BSearchNearest<T>(array :ArrayLike<T>, searchValue :number, arrayGetValue :(element :T)=>number, maxDelta? :number) {
    if (array.length==0) return -1;
    let i= BSearch(array, (element) => arrayGetValue(element) - searchValue, "greatOrEqual");
    let indexes : number[] = [];
    if (i==-1) i= array.length-1;
    else
        if (i>=0) indexes.push(i-1);
    indexes.push(i);
    let delta= maxDelta ?? Number.MAX_VALUE;
    let index= -1;
    for(let i of indexes) {
        let d= Math.abs(arrayGetValue(array[i]) - searchValue);
        if (d <= delta) { delta= d;  index=i; }
    }
    return index;
}


//export function MathMin<T extends { valueOf() : number}> (a :T,  b :T)  { let x= a.valueOf(), y= b.valueOf();  return x }

/** Нормализация точности числа
*/
export function NormalizeDouble(value :number, digits :number) { let factor= 10**digits;  return Math.round(value * factor)/factor; }

function fabs(value : number) { return Math.abs(value); }

function round(value : number) { return Math.round(value); }


function __GetMaxCommonDivisor(a :number,  b :number,  digits :number)    // a > b !!!
{
	let precis= 0.1**(digits)/2;
	while(true) {  //b= NormalizeDouble(b, digits);
		if (b < precis) return NormalizeDouble(a, digits);// b= NormalizeDouble(b, digits);  if (b==0) return a;
		a= fabs(a-round(a/b)*b);  //a= NormalizeDouble(a, digits);
		if (a < precis) return NormalizeDouble(b, digits);
		b= fabs(b-round(b/a)*a);
	}
}


function __GetMaxCommonDivisorInteger(a :number, b :number)    // a > b !!!
{
	while(true) { if (b<1) return a;  a= a%b;  if (a<1) return b;  b= b%a; }
}

/** Наибольший общий делитель двух чисел
 */
export function MaxCommonDivisor(a :number,  b :number,  digits :number=8)
{
	if (a==undefined || b==undefined) { throw new Error("!!! Undefined value in MaxCommonDivisor"); }// console.trace(); }//  return undefined; }
	a= fabs(a);  b= fabs(b);
	if (Number.isInteger(a) && Number.isInteger(b))
		if (a>b) return __GetMaxCommonDivisorInteger(a, b);
		else     return __GetMaxCommonDivisorInteger(b, a);

	if (a>b) return __GetMaxCommonDivisor(a, b, digits);
	else     return __GetMaxCommonDivisor(b, a, digits);
}


//console.log(MaxCommonDivisor(0, 301.84, 1));

/** Наибольший общий делитель массива чисел
 */
export function MaxCommonDivisorOnArray(values : Iterable<number>,  precisDigits : number =8)
{
	let divis=0;
	for (let value of values) { //let i=0;  i<values.length;  i++)
		divis = MaxCommonDivisor(value, divis, precisDigits);
	}
	return divis;
}



/** Определение точности числа (число цифр после запятой)
 * @param value
 * @param mindigits - Минимальная точность
 * @param maxdigits - Максимальная точность
 */
export function GetDblPrecision2(value :number, mindigits :number, maxdigits :number)
{
	maxdigits= Math.min(maxdigits, 16);
	let epsilon= Math.pow(0.1, maxdigits+1);
	//console.log(value);
	let d;
	for (d=mindigits; d<maxdigits; d++) {
		//console.log(d,": ",fabs(value-NormalizeDouble(value, d)),"<?", epsilon);
		if (fabs(value-NormalizeDouble(value,d)) < epsilon) break;
	}
	//console.log(d);
	if (d<0 || d>=100) throw new Error("wrong digits:  value="+value+"  mindigits="+mindigits+"  maxdigits="+maxdigits);
	return d;
};


/** Определение точности числа (число цифр после запятой)
 * @param value
 * @param maxdigits - Максимальная точность
 */
export function GetDblPrecision(value :number, maxdigits :number =8) { return GetDblPrecision2(value, 0, maxdigits); }


//-------------------------------------------------------
/** Преобразование числа в стринг с автоматической точностью
 * @param value
 * @param minprecis - Минимальная точность (число цифр после запятой)
 * @param maxprecis - Максимальная точность (число цифр после запятой)
 */
function DblToStrAuto2(value :number,  minprecis :number,  maxprecis :number)  { return value?.toFixed( GetDblPrecision2(value, minprecis, maxprecis) ); }

/** Преобразование числа в стринг с автоматической точностью
 * @param value
 * @param maxprecis - Максимальная точность (число цифр после запятой).  Если отрицательное число, то это минимально число значащих цифр
 */
export function DblToStrAuto(value :number, maxprecis :number=8) {
	let digits= maxprecis;
	if (digits<0) if (value!=0) maxprecis= Math.trunc( Math.max(0, -digits-Math.log10(fabs(value))) ); else maxprecis=0;
	return DblToStrAuto2(value, 0, maxprecis);
}
/** Нормализация точности числа
 * * @param value
 *  * @param digitsPoint - Максимальная точность (число цифр после первой значимой цифры, только для дробной части).
 *  * @param digitsR - Максимальная точность (число цифр после первой значимой цифры и для целых тоже, пример: 12340000).
 *  */
export function NormalizeDoubleAnd(a: number, options?: {digitsPoint?: number, digitsR?: number, type?: "max" | "min"}) {
	if (a == 0) return a
	let {digitsPoint:w = 4, digitsR:r} = options ?? {}
	if (!r && a%1.0 == 0) return a
	if (a == 0) return 0
	if (r) w = r//
	let k = Math.ceil(Math.log10(Math.abs(a)))
	const func = options?.type == "max" ? Math.ceil : options?.type == "min" ? Math.floor : Math.round
	if (k > w && !r) return func(a)
	if (k >=0) return func(a / (10 ** (k-w))) * (10 ** (k-w))
	return func(a / (10 ** (k-w))) * (10 ** (k-w))
}
/** Преобразование числа в стринг с автоматической точностью
 * @param value
 * @param digitsPoint - Максимальная точность (число цифр после первой значимой цифры, только для дробной части).
 * @param digitsR - Максимальная точность (число цифр после первой значимой цифры и для целых тоже, пример: 12340000).
 */
export function DblToStrAnd(a: number, options?: {digitsPoint?: number, digitsR?: number, type?: "max" | "min"}) {
	let {digitsPoint:w = 4, digitsR:r} = options ?? {}
	if (!r && a%1.0 == 0) return a.toString()
	if (a == 0) return "0"
	if (r) w = r
	let a2 = Math.abs(a)
	const k = Math.floor(Math.log10(a2))
	const func = options?.type == "max" ? Math.ceil : options?.type == "min" ? Math.floor : Math.round
	if (k +1>= w && !r) return func(a).toString()
	if (k +1>= w && r) return (func(a / (10 ** (k-w +1))) * (10 ** (k-w +1))).toString()
	return (func(a / (10 ** (k-w +1))) * (10 ** (k-w +1))).toFixed(w - k - 1)
}

function testDblToStrAnd(){
	const r = 0.047952487787
	for (let i = -10; i < 10; i++) {
		const z =DblToStrAnd(r * (10 ** i), {digitsR: 2, type: "min"})
		console.log(z)
	}
	for (let i = -10; i < 10; i++) {
		const z =DblToStrAnd(r * (10 ** i), {digitsR: 2, type: "max"})
		console.log(z)
	}
}
// test()

export function ArrayItemHandler<T extends {[key:number]:any}> (getter : (target :T, i :number)=> T[number],  setter? : (target :T, i :number, value :T[number])=> void)
: ProxyHandler<T> {
	return {
		get: function (target :T, prop : any) {
			//console.log("! ", prop);
			if (prop in target) {
				return target[prop];
			}
			//let num= Number.parseInt(prop);
			//if (num!=undefined && !isNaN(prop)) return getter(target, prop);  // значение по индексу
			let num= typeof prop=="number" ? prop : typeof(prop)=="string" ? Number.parseInt(prop) : undefined;
			if (num!=undefined && !isNaN(num)) return getter(target, prop);
			//if (Number.isSafeInteger(prop)) return getter(target, prop);
			//console.error("!! ArrayItemHandler:  unknown property for get: ", prop);
			return target[prop];
		},
		set: !setter ? undefined :
			function (target :T, prop :any, value :T[any], receiver :any) : boolean {
				//console.log("! ", prop);
				if (prop in target) {
					target[prop]= value;
					return true;
				}
				let num= typeof(prop)=="number" ? prop : typeof(prop)=="string" ? Number.parseInt(prop) : undefined;
				//console.log(prop);
				//let num= Number.parseInt(prop);
				if (num!=undefined && !isNaN(num)) { setter(target, prop, value); return true; }//  if (ok==undefined) ok=true;  return ok as boolean; } // значение по индексу
				//if (Number.isSafeInteger(prop)) { let ok= setter(target, prop, value);  if (ok==undefined) ok=true;  return ok as boolean; }
				//let z : T;
				//console.error(`!! ArrayItemHandler:  unknown property for set: `, prop);
				//console.trace(); //throw "error";
				target[prop]= value;  return true;
			}
	};
}

/** Создать прокси для доступа к массиву
*/
export function CreateArrayProxy<T extends {[key:number]:any}> (
    target :T,
    getter : (i :number)=> T[number],
    setter? : (i :number, value :T[number])=> void
) : T;

/** Создать прокси для доступа к массиву
*/
export function CreateArrayProxy<T extends {[key:number]:any}, T2 extends {[key:number]:T[number]}> (
    target : T,
    srcArray : T2
) : T;

/** Создать прокси для доступа к массиву
*/
export function CreateArrayProxy<T extends {[key:number]:any}, T2 extends {[key:number]:any}> (
    target :T,
    getterOrArray : T2 | ((i :number)=>T[number]),
    setter? : (i :number, value :T[number])=> void
) {
    if (typeof getterOrArray=="object") return CreateArrayProxy(target, (i)=>getterOrArray[i], (i, val)=> getterOrArray[i]=val);
    return new Proxy(target, ArrayItemHandler((target, i)=>getterOrArray(i), setter ? (target, i, value)=>setter(i, value) : undefined));
}


// {
// let a : { [key :number] : any; } = {};
//
// a[100]= "a";
// a[10]= "b";
// a[-10]= "c";
// a[-100]= "d";
//
// console.log(Object.keys(a));
//
// class C { a=10;  key() { return this.a; } }
// let b = new C();
// for(let k of Object.keys(b)) console.log(k)
//
// let c= new C;
// c.a=20;
// Object.assign(c, b);
// //c.a=20;
//
// console.log("!!!",c.key());
//
// }

//export function Min(...dates :Date[]) { return dates.length>=2 ? dates[0]<dates[1] ? dates[0] : dates[1]; }

//type Keyable<T> = { valueOf():number; }; //constructor(key :number) : T;


class __NumMap<T> {
    [nkey:number] : T;
    *keys()    { for(let keyStr of Object.keys(this)) { let key= Number(keyStr);  /*if (!isNaN(key))*/ yield key; }}
    *values()  { for(let keyStr of Object.keys(this)) { /*let key= Number(keyStr);  if (!isNaN(key))*/ yield this[keyStr as any]; } }
    *entries() { for(let keyStr of Object.keys(this)) { let key= Number(keyStr); /*if (!isNaN(key))*/ yield [key, this[keyStr as any]] as const; } }
    clone()    { return Object.assign(new __NumMap, this); }
    clear()    { for(let k of Object.keys(this)) delete this[k as any]; }
}

export class __MyMap<K extends {valueOf():number},  V>  //(K extends {valueOf():number} ? lib.CBase : lib.CBase)
{
	protected map = new __NumMap<{key:K, value:V}>;
	//protected pairs: {key:K, value:V}[];
	protected keys? : readonly K[]|null;
	protected values? : readonly V[]|null;
	//protected strToKey(strKey) { return this.map[strKey].key; }
	protected createArrays() {
		let thisKeys: K[] = this.keys = [];
		let thisValues: V[] = this.values = [];
        for(let pair of this.map.values()) {
            thisKeys.push(pair.key);
            thisValues.push(pair.value);
        }
	}
	protected OnModify?(key :K) { }
	public Set(key :K, value :V) :void  { this.map[key.valueOf()]= { key, value };  this.keys= null;  this.OnModify?.(key); }//this.pairs=null; }// this.keys= null;  this.values=null; }
	public Get(key :K) :V|undefined     { let pair = this.map[key.valueOf()];  return pair ? pair.value : undefined; }
	public Contains(key :K) : boolean { return this.map[key.valueOf()]!=undefined; }
	public TryAdd(key :K, value :V) : boolean { if (!this.Contains(key)) return false;  this.Set(key, value);  return true; }
	public Add(key :K, value :V) : void { if (! this.TryAdd(key,value)) throw new Error(`Key ${key} is already exists for ${typeof value}`); }
	public Remove(key :K)  { delete(this.map[key.valueOf()]);  this.keys= null;  this.OnModify?.(key); }
	public Clear()    { let pairs= this.OnModify ? this.map.values() : [];  this.map.clear();  this.keys=undefined;  this.values=undefined;  for(let p of pairs) this.OnModify!(p.key); }
	public Count()    { return this.sortedKeys.length; }
	get sortedKeys() :readonly K[]  { if (!this.keys) this.createArrays();  return this.keys!; }//{ this.keys=[]; for(let key in Object.keys(this.map)) if (!isNaN(key as any)) this.keys.push(this.strToKey(key));  return this.keys; }
	//get sortedKeys() :K[] { if (!this.keys) this.keys= Object.keys(this.map).filter((key)=>!isNaN(key as any)) as any[];  return this.keys; }
	get Values() :readonly V[]  { if (!this.keys) this.createArrays();  return this.values!; }//{ this.values=[];  for(let key of this.sortedKeys) this.values.push(this.map[key.valueOf()].value); }  return this.values; }

    assign(other :__MyMap<K,V>) { this.map= other.map.clone();  this.keys= other.keys;  this.values= other.values; }
}
//-------------------------------

export class MyMap<K extends {valueOf():number},  V>  extends __MyMap<K, V> //(K extends {valueOf():number} ? lib.CBase : lib.CBase)
{
	readonly [key :number]: void;

	Clone() { let newobj= new MyMap<K,V>();  newobj.assign(this);  return newobj; }
}

//------------------------

export class MyNumMap<VAL> extends __MyMap<number, VAL>
{
	[key :number] : VAL|undefined;
	constructor() {
		super();
		return CreateArrayProxy(this, (i)=>this.Get(i), (key, value)=>this.Set(key, value ??(()=>{throw new Error("undefined value")})())); //value!=undefined ? obj.Set(key,value) : obj.Remove(key));
	}
	Clone() { let newobj= new MyNumMap<VAL>();  newobj.assign(this);  return newobj; }

	//static fromParsedJSON(data : ParsedUrlQueryInputMy) : MyNumMap<VAL> { let obj= new MyNumMap;   }
}




export class StructMap<TKey extends Required<TKey> & { [key:string]:number|string }|{ [key:number]:number|string }, TResult>
{
	//private _data = new Map<any, TResult|Map<any,TResult>>();
	private _data : {[key:string]:any; [key:number]:any} = {};
	private _keys : TKey[] = [];
	private _values : TResult[] = [];
	[Symbol.iterator]() { return this.entries(); }

	set(key :TKey, value :TResult) {
		let items= key instanceof Array ? key : Object.values(key);
		if (! items?.length) throw new Error("passed empty object as key");
		let obj= this._data;
		for(let i=0; i<items.length-1; i++) { //item of key) {
			let item= items[i];
			obj= (obj[item] ??= {});
			//let gotObj= obj.get(item);
			//if (gotObj==null) obj.set(item, gotObj= new Map<any,TResult>()); // obj[item as any]= {};
			//obj= gotObj;
		}
		//obj[key[key.length-1] as any]= value;
		obj[items[items.length-1]]= value;
		this._keys.push(key instanceof Array ? [...key] as unknown as TKey : {...key});
		this._values.push(value);
	}

	get(key :TKey) : TResult|undefined {
		let items= key instanceof Array ? key : Object.values(key);
		if (items.length==0) return undefined;
		let obj= this._data;
		for(let item of items) {
			obj= obj[item];
			if (!obj) return undefined;
		}
		return obj as TResult;
	}

	has(key :TKey) { return this.get(key)!=null; }

	keys() { return this._keys; }
	values() { return this._values; }
	*entries() { for(let [i,key] of this._keys.entries()) yield [key, this._values[i]]; }
}


//export class StructSet<TItem extends number|string>
export class StructSet<TKey extends Required<TKey> & { [key:string]:number|string }|{ [key:number]:number|string }>
{
	private data= new StructMap<TKey, any>();
	[Symbol.iterator]() { return this.keys(); }
	add(key :TKey) { return this.data.set(key,null); }
	has(key :TKey) { return this.data.has(key); }
	keys() { return this.data.keys(); }
	values() { return this.data.keys(); }
}


export class ArrayMap<TKey extends number|string, TVal> extends StructMap<readonly TKey[], TVal>
{
}

export class ArraySet<TKey extends number|string> extends StructSet<readonly TKey[]>
{
}



// export interface ISimpleMapString<TVal> {
// 	[key : string] : TVal;
// 	entries() { return Object.entries(this); }
// 	keys() { return Object.keys(this); }
// 	values() { return Object.values(this); }
// }
//
// export class SimpleMapString<TVal> {
// 	[key : string] : any;
// 	entries() { return Object.entries(this); }
// 	keys() { return Object.keys(this); }
// 	values() { return Object.values(this); }
// }


//-----------------------------------

export interface IItems<T> extends ArrayLike<T>
{
	readonly [i : number]: T;
	readonly length : number;
	[Symbol.iterator]() : Iterator<T>;
}

/*
export abstract class CItemsWrap<T> implements IItems<T>
{
	readonly [i : number]: T;
	readonly length : number;
	[Symbol.iterator]() : Iterator<T>;
}
*/

export class VirtualItems<T> implements IItems<T>
{
	private  getLength : ()=>number;
	readonly getValue : (i : number)=>T;
	get length() : number { return this.getLength(); }
    readonly [i : number]: T;
    *[Symbol.iterator]()  { let len= this.length;  for (let i=0; i<len; i++) yield this.getValue(i); }

	constructor(itemGetter: (i:number)=>T,  lengthGetter: ()=>number) {
		this.getLength= lengthGetter;  this.getValue= itemGetter;
		return CreateArrayProxy(this, itemGetter);
	}
}

/*
class A
{
	arr = [10,20,30,40,50];

	items= new VirtualItems((i)=>this.arr[i], ()=>this.arr.length);
}


let a= new A;

//console.log(a.items[3]);
for(let item of a.items)
	console.log(item);
*/
/*
class A { }

let a : A = {}

a[10]= "hi";

console.log("len=",Object.keys(a).length,"  values: ", Object.keys(a));

a[10]= undefined;

console.log("len=",Object.keys(a).length,"  values: ", Object.keys(a));
*/

//function *Generator()  { for (let i=100; i<105; i++) yield i; }  // Итератор времени

//for (let val of Generator()) console.log(val);
//console.log(Generator[2]);




let sss! : PickTypes<{a :number, b :string}, string>;



type FilterType<srcType, excludeType, extractType> = Exclude<srcType, excludeType> extends extractType ? Extract<Exclude<srcType, excludeType>, extractType> : never;

// export type ParsedUrlQueryInputMy<T=any> =
// 	T extends never|never[] ? never : T extends object[] ? ParsedUrlQueryInputMy<T[0]>[] : {
// 		readonly [key in KeysWithoutType<T, Function>]:
// 			Extract<T[key], number|string|boolean|null|undefined|(number|string|boolean|null|undefined)[]>
// 			| (
// 				T[key] extends const_Date ? string  : T[key] extends const_Date[] ? readonly string[] : never
// 			)
// 			|
// 			( ParsedUrlQueryInputMy< Extract< Exclude<T[key],const_Date[]>, object[] > > )
// 				//Exclude<T[key], const_Date[]> extends any[] ? ParsedUrlQueryInputMy< Extract<Exclude<T[key], const_Date[]>,any[]>[0]>[] : never
// 			|
// 			( ParsedUrlQueryInputMy< Extract< Exclude<T[key],any[]|const_Date>, object > > )
// 				//Exclude<T[key], any[]> extends object ? ParsedUrlQueryInputMy< Exclude<T[key], any[]>> : never
// 		// ( Exclude<T[key], const_Date[]> extends object ?  ParsedUrlQueryInputMy<T[key]>[] : never)
// 			// // 	: T[key] extends (number|string|boolean)[] ? Extract<T[key], (number|string|boolean)[]>
// 			// 	: T[key] extends object[] ? readonly ParsedUrlQueryInputMy<T[key][0]>[]
// 			// // 	: T[key] extends object ? ParsedUrlQueryInputMy<T[key]>|{a: number}
// 			// // 	: T[key]
// 	}

type ParsedUrlQueryInputObj<T> = T extends never|never[] ? never : {
	readonly [key in KeysWithoutType<T, Function>] : ParsedUrlQueryInputMy<T[key]>;
}
type ParsedUrlQueryInputArr<T extends any[]> = T extends never ? never : ParsedUrlQueryInputMy<T[0]>[]

export type ParsedUrlQueryInputMy<T=any> =   //T extends never|never[] ? never :
	Extract<T, number|string|boolean|null|undefined|readonly(number|string|boolean|null|undefined)[]>
	|
	(T extends const_Date ? string  : T extends const_Date[] ? readonly string[] : never)
	|
	ParsedUrlQueryInputArr< Extract< Exclude<T, readonly const_Date[]>, object[] > > // >[0] >[]
	|
	ParsedUrlQueryInputObj< Extract< Exclude<T, const_Date|readonly any[]>, object> >


//let zzz : ParsedUrlQueryInputMy<string>;


//type XXX = Exclude<number[]|number|Promise<any>[], object>;


// export type ParsedUrlQueryInputMy<T=any> = {
// 	readonly [key in KeysWithoutType<T, Function>]:
// 	T[key] extends number|string|boolean|null|undefined|(number|string|boolean|null|undefined)[] ? T[key]
// 	: T[key] extends const_Date ? string  : T[key] extends const_Date[] ? readonly string[]
// 	: T[key] extends [] ? ParsedUrlQueryInputMy< Exclude<T[key], const_Date[]|null|undefined>[0]>[]
// 	: T[key] extends object ? ParsedUrlQueryInputMy< Exclude<T[key], const_Date|[]|null|undefined>> : never
// 	// ( Exclude<T[key], const_Date[]> extends object ?  ParsedUrlQueryInputMy<T[key]>[] : never)
// 	// // 	: T[key] extends (number|string|boolean)[] ? Extract<T[key], (number|string|boolean)[]>
// 	// 	: T[key] extends object[] ? readonly ParsedUrlQueryInputMy<T[key][0]>[]
// 	// // 	: T[key] extends object ? ParsedUrlQueryInputMy<T[key]>|{a: number}
// 	// // 	: T[key]
// }





// export type ParsedUrlQueryInputMy<T=any> = {
// 	readonly [key in keyof T]:
// 		T[key] extends (string | number | boolean | string[] | number[] | boolean[] | null | undefined) ? T[key]
// 		: T[key] extends const_Date ? string  : T[key] extends const_Date[] ? readonly string[]
// 		//: T[key] extends Function ? undefined
// 		: T[key] extends []  ? readonly ParsedUrlQueryInputMy<T[key][0]>[]  : T[key] extends object  ? ParsedUrlQueryInputMy<T[key]>
// 		: string | number | boolean | readonly string[] | readonly number[] | readonly boolean[] | null | undefined | ParsedUrlQueryInputMy | readonly ParsedUrlQueryInputMy[];
// }; //&{ _dummy; }; //implements ParsedUrlQueryInputMy { }



// export interface JSON {
// 	stringify(obj?: ParsedUrlQueryInputMy, sep?: string, eq?: string, options?: StringifyOptions): string;
// 	parse(str: string, sep?: string, eq?: string, options?: ParseOptions): ParsedUrlQuery;
// }

export interface JSON {
	stringify(obj?: ParsedUrlQueryInputMy): string;
	parse<T=any>(str: string): ParsedUrlQueryInputMy<T>;
}


export function JSON_clone<T>(obj: T): ParsedUrlQueryInputMy<T> {
	return JSON.parse(JSON.stringify(obj));
}



export interface ICancelToken
{
	isCancelled() : boolean;
}

export class CancelToken implements ICancelToken
{
	private _cancel = false;
	isCancelled() { return this._cancel; }
	cancel()      { this._cancel= true; }
	//static fromFunc(func : ()=>boolean)) : ICancelToken { return { isCancelled() { return }  }
}



export class CancelablePromise<T> extends Promise<T> {
	private static _rejectTmp : (reason?: any) => void;
	private readonly _reject? : (reason?: any) => void;
	private readonly _onCancel? : ()=>void;
	constructor(
		executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void,
		onCancel?: ()=>void
	){
		super( (resolve, reject)=>{ CancelablePromise._rejectTmp= reject;  executor(resolve, reject); } );
		this._reject= CancelablePromise._rejectTmp;
		this._onCancel= onCancel;
	}
	cancel(msg?:string) { if (this._onCancel) this._onCancel();  return this._reject!(msg); } //if (this.oncancel)

	static override resolve() : CancelablePromise<void>; //{ return new CancelablePromise<void>((resolve)=>resolve()); }
	static override resolve<T>(value: T | PromiseLike<T>) : CancelablePromise<T>;
	static override resolve<T>(value?: T) { return new CancelablePromise<T|void>((resolve, reject)=>Promise.resolve(value).then(resolve, reject) ); }
}





// Таймер с проверкой условия (если OnTimer возвращает ложь, то таймер останавливается (промис завершается с реджектом!)
export function createCancellableTimer(interval_ms :number,  onTimer :()=>boolean|void,  onStop? :()=>void) {
	let timer : ReturnType<typeof setInterval>; // number;
	function stop() { clearInterval(timer);  onStop?.(); }
	let executor= (resolve :(res:never)=>void, reject :(message:string)=>void)=> {
		timer= setInterval(()=> { if (onTimer()==false) { stop();  reject("Stopped"); } }, interval_ms);
	}
	return new CancelablePromise<never>(executor, ()=> stop() );//.finally(()=>clearInterval(timer));
}

//---------------------------

export async function createCancellableTaskWrapper<T>(task :Promise<T>, isStopped :()=>boolean, interval_ms=50) {
	let stopCheckingTask= createCancellableTimer(interval_ms, ()=> ! isStopped?.());
	try {
		return await Promise.race([task, stopCheckingTask]);  // завершается при любом событии
	}
	catch(e) {
		if (isStopped?.()) return "stopped";
		throw e;
	}
	finally {
		stopCheckingTask.cancel();
	}
}


export class MyTimerInterval {
	private _timer;
	private _onstop;
	constructor(period_ms :number,  onTimer: ()=>void,  onStop?: ()=>void) { this._timer= setInterval(onTimer, period_ms);  this._onstop= onStop; }
	stop() { clearInterval(this._timer);  this._onstop?.(); }
}



export class Mutex {
	private mutex = Promise.resolve();

	lock(): PromiseLike<() => void> {
		let begin: (unlock: () => void) => void = unlock => {};

		this.mutex = this.mutex.then(() => {
			return new Promise(begin);
		});

		return new Promise(res => {
			begin = res;
		});
	}

	async dispatch<T>(fn: ()=>T|PromiseLike<T>): Promise<T> {
		const unlock = await this.lock();
		try {
			return await fn();
		} finally {
			unlock();
		}
	}

	static createLock() { return (new Mutex).lock(); }
}



// declare var navigator : any;
// declare var window : any;
// declare var document : any;

/** Копирование в буфер обмена
*/
export async function copyToClipboard(textToCopy: string)
{
    const {navigator, window, document} = globalThis as any;
    const childProcessModule= 'child_process';
	if (typeof window != "object") // node
		return (await import(/* webpackIgnore: true */ childProcessModule) as typeof import("child_process")).spawn('clip').stdin.end(textToCopy);
    // navigator clipboard api needs a secure context (https)
    if (navigator.clipboard && window.isSecureContext) {
        // navigator clipboard api method'
        return navigator.clipboard.writeText(textToCopy);
    } else {
        // text area method
        let textArea = document.createElement("textarea");
        textArea.value = textToCopy;
        // make the textarea out of viewport
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        return new Promise<void>((res, rej) => {
            // here the magic happens
            document.execCommand('copy') ? res() : rej();
            textArea.remove();
        });
    }
}

//copyToClipboard("AAA");




declare type Nominal<T, Name extends string> = T & { [Symbol.species]: Name; }

//export type HLineID= Nominal<{readonly idNum: number}, "HLineID">

// type A<T> = { [Symbol.species]: A<T>; }
//
// let a! : A<number>;// = { [Symbol.species]: "abc" }
//
// let b! : number = a;


//type ObjectID<Name extends string, TObject, TOwner> = Nominal<{readonly value: number}, Name>

export type ObjectID<TObject, TOwner> = { readonly value: number;  readonly [Symbol.species]: ObjectID<TObject,TOwner> }

// type HLineID_private = HLineID & Readonly<{line :IHLine, owner :CSignal2Bar}>; //, [Symbol.species]: "HLineID"}>;
// type HLineID_private2 = {line :IHLine, owner :CSignal2Bar};
//class CObjectID<IdClassName extends string, TObject, TOwner> implements ObjectID<IdClassName, TObject, TOwner> {
export class CObjectID<TObject, TOwner> implements ObjectID<TObject, TOwner> {
	static #id=1;
	readonly value = CObjectID.#id++;
	readonly #object :TObject;
	readonly #owner :TOwner;
	readonly [Symbol.species] = this as ObjectID<TObject, TOwner>; //ObjectID<TObject, TOwner>;
	// readonly [Symbol.species]: IdClassName;
	readonly toString = ()=>{ return this.value+""; }
	constructor(object :TObject, owner :TOwner) { this.#object= object;  this.#owner= owner; }
	// static getPrivateInfo<IdClassName extends string, TObject, TOwner>(data :CObjectID<IdClassName, TObject, TOwner>) {
	static getInfo<TObject, TOwner>(id :ObjectID<TObject, TOwner>) : { object: TObject, owner: TOwner } {
		let obj= id as CObjectID<TObject, TOwner>;  return { object: obj.#object, owner: obj.#owner }
		//return id instanceof CObjectID ? { object: id.#object, owner: id.#owner } : (()=>{throw "wrong id object"})();
	}
	static getObjectByOwner<TObject, TOwner>(id :ObjectID<TObject, TOwner>, owner :TOwner) { let data= CObjectID.getInfo(id);  return data.owner==owner ? data.object : undefined; }
}

// заменяем stringify, т.к. иначе может быть рекурсивная обработка id в других объектах
const stringifyDefault= JSON.stringify;

JSON.stringify= (value, replacer, space)=>stringifyDefault(value, (key,val)=>val instanceof CObjectID ? val.value+"" : typeof replacer=="function" ? replacer(key,val) : val, space);



export class MapExt<K,V> extends Map<K,V> {
    private immutArray? :readonly V[];
    override set(key :K, value :V) { this.immutArray=undefined;  return super.set(key, value); }
    override delete(key :K) { this.immutArray=undefined;  return super.delete(key); }
    valuesArrayImmutable() { return this.immutArray ??= [...this.values()]; }
    getOrSetFunc(key :K, val :()=>V) {
        let v= this.get(key);  if (v===undefined && !this.has(key)) this.set(key, v= val());
        return v as V;
    }
    getOrSet(key :K, val : V) { return this.getOrSetFunc(key, ()=>val); }
}


export class WeakMapExt<K extends object, V> extends WeakMap<K,V> {
    getOrSetFunc(key :K, val :()=>V) {
        let v= this.get(key);  if (v===undefined && !this.has(key)) this.set(key, v= val());
        return v as V;
    }
    getOrSet(key :K, val : V) { return this.getOrSetFunc(key, ()=>val); }
}


//кэшируемое значение по ключу в виде кортежа
export class CCachedValueT<TKey extends [any, ...any], TVal> {
    private key?: TKey;
    private val? :TVal;
    private size :number;
    constructor(size :number) { this.size= size; }
    getOrSet(key :TKey, valFunc :()=>TVal) {
        //if (key==this.key) return this.val;
        if (!this.key) { this.key=[...key];  return this.val= valFunc(); }
        for(let i=0; i<this.size; i++)
            if (key[i]!=this.key[i]) { this.key=[...key];  return this.val= valFunc(); }
        return this.val!;
    }
}

export class CCachedValue2<TKey extends [any, any], TVal> extends CCachedValueT<TKey, TVal> { constructor() { super(2); } }


// проверяет, может ли объект приводиться к объекту типа T, проверяя наличие полей в массиве members

export function isObjectCastableTo<T extends object>(object :{}, members :readonly (keyof T)[]) : object is T {
    let keys= Object.keys(object);
    for(let m of members)
        if (! keys.includes(m as string)) return false;
    return true;
}