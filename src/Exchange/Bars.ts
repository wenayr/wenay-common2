///<reference path="../Common/BaseTypes.ts"/>

// /// <reference no-default-lib="false"/>
// ///<reference types="../BaseTypes"/>


import * as lib from "../Common/common";
import {BSearch,CreateArrayProxy, deepEqual,GetDblPrecision, IItems,NormalizeDouble, ParsedUrlQueryInputMy, SearchMatchMode, VirtualItems} from "../Common/common";
import {D1_MS, Period, TF, TFIndex} from "../Common/Time";
import {ByteStreamR, ByteStreamW, Nullable, NumericTypes} from "../Common/ByteStream"
import {const_Date, ReadonlyFull} from "../Common/BaseTypes";
//import {ParsedUrlQueryInput} from "querystring";

export * from "../Common/Time";




export class OHLC {
	readonly open! :number; readonly high! :number; readonly low! :number; readonly close! :number;
	constructor(open :number, high :number, low :number, close :number) { return Object.assign(this, { open, high, low, close }); }
}


export type IBar = CBarBase;


export class CBarBase  // класс бара
{
	readonly time : const_Date;
	readonly open : number;
	readonly high : number;
	readonly low : number;
	readonly close : number;
	readonly volume : number;
	readonly tickVolume :number;
	constructor(data :CBarBase);
	constructor(time :const_Date,  open :number,  high :number,  low :number,  close :number,  volume?: number, tickVolume? :number);

	constructor(timeOrBar :const_Date|CBarBase,  open =0,  high=0,  low=0,  close=0,  volume=0, tickVolume=0) {
		function isDate(obj :unknown) : obj is const_Date { return obj instanceof Date; }
		//if (!isDate(timeOrBar)) {time,open, high,low,close,volume} = timeOrBar;
		if (isDate(timeOrBar)) {
		//[this.time, this.open, this.high, this.low, this.close, this.volume]= [time, open, high, low, close, volume]
			this.time= timeOrBar;  this.open= open;  this.high= high;  this.low=low;  this.close=close;  this.volume= volume;  this.tickVolume= tickVolume;
		}
		else {
			let b= timeOrBar;
			this.time= b.time;  this.open= b.open;  this.high= b.high;  this.low=b.low;  this.close=b.close;  this.volume= b.volume;  this.tickVolume= b.tickVolume;
		}
	}
}



export class CBar extends CBarBase
{
	//public constructor(time :const_Date,  open :number,  high :number,  low :number,  close :number,  volume: number =0) { super(time, open, high, low, close, volume); }
	static new(time :const_Date,  ohlc :OHLC,  volume: number =0, tickVolume=0) : CBar {
		return new CBar(time, ohlc.open, ohlc.high, ohlc.low, ohlc.close, volume, tickVolume);
	}

	static fromParsedJSON(data :ParsedUrlQueryInputMy<CBar>) { return new CBar(new Date(data.time), data.open, data.high, data.low, data.close, data.volume, data.tickVolume ?? 0); }
}

export type BarInfo = Readonly<{ bar :CBar, closed :boolean, index :number, getAllBars :()=>IBars }>;





export interface ITick
{
	readonly time : const_Date;
	readonly price : number;
	readonly volume : number;
}


export class CTick implements ITick
{
	readonly time : const_Date;
	readonly price : number;
	readonly volume : number;

	constructor(time :const_Date, price :number, volume :number)  { this.time=time; this.price=price; this.volume=volume; };
}



/*
interface CItems
{
	constructor();
}
*/

function getDraftTickSize(bars : IBars) { return bars instanceof CBarsBase ? bars._tickSize : bars.tickSize; }


//let aaa : IBars = null as unknown as IBarsImmutable;

// type XXXX = Readonly<number & {[Symbol.species] : "aaa"}>; //Readonly<TFIndex>;
// let zzz : Readonly<number & {readonly [Symbol.species] : "aaa"}> = 0 as unknown as Readonly<number & {[Symbol.species] : "aaa"}>;
// let NNN! : number & {readonly [Symbol.species] : "aaa"}
// let nnn : number= NNN;
// let bbb : TFIndex = undefined as unknown as Readonly<TFIndex>;
//
// let bbb2 : TFIndex = undefined as unknown as ReadonlyFull<TFIndex>;
//
// export type IBarss = Readonly<CBarsBase>;
// let aa :IBars= undefined as unknown as IBarss;


export abstract class IBars implements Iterable<CBar> // extends Array<CBar>
{
	readonly [key : number] : CBar;

	[Symbol.iterator]() { return this.data[Symbol.iterator]() as Iterator<CBar>; }//  let x = this.data[Symbol.iterator]();  }  //убираем отсюда, иначе невозможно будет неявное преобразование: IBars -> IBars

	// Таймфрейм
	readonly Tf : TF;

	constructor(tf :TF) { //,  bars :Iterable<CBar>,  tickSize? :number) { //isImmutable? : boolean) {
		//this._data= isImmutable && (bars instanceof Array)  ? bars  : [...bars];
		this.Tf= tf;
		console.assert(tf.msec <= TF.W1.msec);  // Делаем такую проверку, т.к. функция closeTime пока не считает для MN1
		return lib.CreateArrayProxy(this,(i)=>this.data[i]);
	}

	abstract get data() : readonly CBar[];  //get data() : readonly CBar[] { return this._data; }

	// Виртуальное свойство мутабельности
	abstract readonly Mutable : boolean;  // { return false; }
	//abstract get isMutable() : boolean;  // { return false; }
	get Immutable() { return !this.Mutable; }

	// Получить иммутабельный объект
	toImmutable() : IBarsImmutable { return this.Mutable ? new CBars(this.Tf, this.data, getDraftTickSize(this)) : this as IBarsImmutable; }

	// число баров
	get count() : number { return this.data?.length ?? 0; }
	// число баров
	get length() : number { return this.count; }
	// последний бар
	get last() : CBar|undefined { return this.count>0 ?  this.data[this.count-1] :  undefined; }

	// Получение бара по индексу задом наперёд
	backwardBar(i :number) { return this.data[this.length-1-i]; }

	_getBar(i :number, prop :string) { return this.data[i] ?? (()=>{console.trace();throw("Wrong bar index: i="+i+", barsTotal="+this.count+", property: "+prop) })() }

	at(i :number) : CBar|undefined { return this.data.at(i); }

	time(i : number) : const_Date { return this._getBar(i, "time").time; }
	open(i : number) : number { return this._getBar(i, "open").open; }
	high(i : number) : number { return this._getBar(i, "high").high; }
	low(i : number) : number { return this._getBar(i, "low").low; }
	close(i : number) : number { return this._getBar(i, "close").close; }
	volume(i : number) : number { return this._getBar(i, "volume").volume; }
	tickVolume(i : number) : number { return this._getBar(i, "tickVolume").tickVolume; }

	closeTime(i :number) : const_Date { return Period.EndTime(this.Tf, this.time(i)); }
	// Время первого бара
	get firstTime() : const_Date|null { return this.count>0 ? this.data[0].time : null; }
	// Время последнего бара
	get lastTime() : const_Date|null { return this.count>0 ?  this.data[this.count-1].time:  null; }
	get lastCloseTime() : const_Date|null { return this.count>0 ? this.closeTime(this.count-1) : null; }

	// Размер тика
	abstract get tickSize() : number; //

	// Массив значений баров по заданному геттеру значения
	Values<T>(getter : (bar:CBar)=>T) { return new VirtualItems((i)=>getter(this.data[i]), ()=>this.data.length); }

	// виртуальные массивы значений баров:
	get times() { return this.Values((bar)=>bar.time); } // массив времени   // return new VirtualItems((i)=>this._data[i].time, ()=>this._data.length); }
	get opens() { return this.Values((bar)=>bar.open); } // массив цен открытия
	get highs() { return this.Values((bar)=>bar.high); }
	get lows() { return this.Values((bar)=>bar.low); }
	get closes() { return this.Values((bar)=>bar.close); }
	get volumes() { return this.Values((bar)=>bar.volume); }

	entries() { return this.data.entries() as IterableIterator<[number, CBar]>; }

	//*times2()  { for (let bar of this.data) yield bar.time; }  // Итератор времени
	//*closes()  { for (let bar of this._data) yield bar.close; } // Итератор цен закрытия
	//*volumes()  { for (let bar of this._data) yield bar.volume; } // Итератор объёмов

	// Индекс бара по времени (match - тип соответствия времени:  меньше/равно, равно, больше/равно). Проверяется попадание искомого времени в бар!
	indexOf(time :const_Date, match? :SearchMatchMode) : number {
		time = Period.StartTime(this.Tf, time);
		return lib.BSearch(this.data, time, (bar, time) => bar.time.valueOf() - time.valueOf(), match ? match : BSearch.EQUAL);
	}
	// Индекс совпадающего или более раннего бара
	indexOfLessOrEqual(time : const_Date) { return this.indexOf(time, "lessOrEqual"); }

	// Создать объект с добавленными барами в конце (текущий объект не меняется)
	concat(newBars : readonly CBar[]|CBar) : CBars|null {
		let bars= newBars instanceof Array ? newBars : [newBars];
		let time= bars && bars.length>0 && this.count>0  ? bars[0].time  : null;
		if (time && time<=this.lastTime!) { console.error("Wrong bar start time:  "+time.toString()+" <= "+this.lastTime!.toString());  return null; }
		return new CBars(this.Tf, this.data.concat(bars), this.tickSize);
	}

	// Создать объект баров в диапазоне
	slice(startIndex :number, stopIndex? :number) : CBars { let result= this.data.slice(startIndex, stopIndex);  return new CBars(this.Tf, result, this.tickSize); }

	sliceMutable(startIndex :number, stopIndex? :number) : CBarsMutable { let result= this.data.slice(startIndex, stopIndex);  return new CBarsMutable(this.Tf, result, this.tickSize); }

	sliceByTime(startTime :const_Date|null, lastTime? :const_Date|null) {
		let arr= this.getArray(startTime, lastTime);
		return new CBars(this.Tf, arr ?? [], this.tickSize);
	}

	*range(timeStart? : const_Date, timeEnd? :const_Date){
		if (this.length==0) return;
		let ibar= timeStart ? this.indexOf(timeStart, "greatOrEqual") : 0;
		timeEnd ??= this.lastTime!
		for(let i=ibar; this.data[i].time<=timeEnd; i++)
			yield this.data[i];
	}

	// Получение массива баров в диапазоне времени
	getArray(startTime? :const_Date|null, lastTime? :const_Date|null) : CBar[]|null
	{
		//if (startTime != Period.StartTime(this.Tf, startTime)) startTime= new PeriodSpan(this.Tf, startTime).next().StartTime();
		//if (lastTime != Period.EndTime(this.Tf, startTime)) startTime= new PeriodSpan(this.Tf, startTime).next().StartTime();
		let istart= startTime ? this.indexOf(startTime, BSearch.GREAT_OR_EQUAL) : 0;
		let ilast= lastTime ? this.indexOf(lastTime, BSearch.LESS_OR_EQUAL) : this.data.length-1;
		//console.log(istart,ilast);
		//console.log("!!!",this.data);
		if (istart==-1 || istart>ilast) return null;
		return this.data.slice(istart, ilast+1);
	}

	// Получение новых баров с выбранным таймфреймом
	toBars(tf :TF, endDayTime_s? :number) : CBarsMutableBase
	{
		let bars= this.toBarsArray(tf, endDayTime_s);
		return new CBarsMutable(tf, bars, this instanceof CBarsBase ? this._tickSize : this.tickSize);
	}

	// Получение новых баров с выбранным таймфреймом
	toBarsImmutable(tf :TF, endDayTime_s? :number) : IBarsImmutable
	{
		if (tf==this.Tf && endDayTime_s==null) return this.toImmutable();
		return Object.assign(this.toBars(tf, endDayTime_s), {Mutable: false}) as IBarsImmutable;
	}

	// Получение новых баров с выбранным таймфреймом
	toBarsArray(dstTf :TF, endDayTime_s? :number) : CBar[] //readonly CBar[]|null
	{
		const src = this;

		if (src.Tf==dstTf && !endDayTime_s) {
			return [...src.data]; //src._data; //dst= [...src._data];
		}
		console.assert(dstTf.sec>0); // if (dstTf.sec==0) { return null;
		let count= src.count;
		let dst : CBar[] = new Array(count);
		//if (!_Resize(bars)) return false;
		let mainTime = count>0 ? src.time(0) : new Date(0);
		let period= new Period(dstTf);  //TPeriodSpan periodspan(period, time);
		let nextPeriodTime= period.span(mainTime).next().startTime;//  (++periodspan).StartTime();
		//if (enddaytime==0) enddaytime= TIME_D1-1;
		//static bool modes[8];  for (BARVALUEMODE m=0; m<8; m++) modes[m]= src.IsModeUsing(m);
		//ArrayCopy(_ModeUsing, modes);
		//if (period!=src.PeriodSeconds() && modes[BAR_CLOSE]) { _ModeUsing[BAR_HIGH]=true;  _ModeUsing[BAR_OPEN]=true;  _ModeUsing[BAR_LOW]=true; }
		let istart=0;
		let ilast=0;
		let n=0;
		for (let i=1; i<=count; i++)
		{
			let bartime = i<count ? src.time(i) : new Date(2100, 1, 1); //INT_MAX / TIME_D1 * TIME_D1;
			if (endDayTime_s &&  bartime.valueOf() % D1_MS >= endDayTime_s*1000 % D1_MS) continue;

			if (bartime >= nextPeriodTime) ///period > time/period)
			{
				let close = src.close(ilast);
				let time= period.span(mainTime).startTime;
				//Object.freeze(time);
				//console.log(bartime,"->",time,"  mainTime=",mainTime, period.name);
				let high= src._getHighestHigh(istart, ilast);
				let low= src._getLowestLow(istart, ilast);
				let open= src.open(istart);
				let volume= src.getSumVolume(istart, ilast); // _SetVolume(n, volume); }
				let tickVolume= src.getSumTickVolume(istart, ilast);
				//if (_ModeUsing[BAR_SPREAD]) _SetSpread(n, src.GetAvrgSpread(istart, (INDEX)ilast));
				dst[n]= new CBar(time, open, high, low, close, volume, tickVolume);
				mainTime= bartime;
				istart=i;  n++;
				nextPeriodTime= period.span(mainTime).next().startTime;
			}
			ilast= i;
		}
		dst.length= n; //splice(n, dst.length-n);  // Удаляем элементы в конце
		return dst;
	}

	_getHighestHigh(i0 :number, i1 :number)  { let a=-Number.MAX_VALUE;  for (let i=i0; i<=i1; i++) a= Math.max(a, this.high(i));  return a; }
	//GetHighestClose(i0 :number, i1 :number) { let a=-Number.MAX_VALUE;  for (let i=i0; i<=i1; i++) a= Math.max(a, this.close(i));  return a; }
	_getLowestLow(i0 :number, i1 :number)    { let a=Number.MAX_VALUE;  for (let i=i0; i<=i1; i++) a= Math.min(a, this.low(i));  return a; }

	// reduce2<T>(getter :(bar :CBar, index? :number)=>T, comparer :(val1 :T, val2 :T)=>boolean, iFirst :number|undefined, iLast :number|undefined) {
	// }
	getBest(comparer :(prevBar :CBar, newBar:CBar)=>boolean, iFirst? :number|undefined, iLast? :number|undefined) {
		iFirst??=0;  iLast??= this.count-1;
		if (iFirst > iLast) return [undefined, undefined]; //throw "iFirst > iLast";
		let n= iFirst, bestBar= this.data[iFirst];
		for (let i=iFirst+1; i<=iLast; i++) {
			let bar= this.data[i];
			if (comparer(bestBar, bar)==true)
				[n, bestBar] = [i, bar];
		}
		return [n, bestBar];
	}

	getFirstHighest(iFirst :number|undefined, iLast :number|undefined)  { return this.getBest((old, current)=>current.high>old.high, iFirst, iLast); }
	getFirstLowest(iFirst :number|undefined, iLast :number|undefined)  { return this.getBest((old, current)=>current.low<old.low, iFirst, iLast); }

	getSumVolume(i0 :number, i1 :number)   { let sum=0;  for (let i=i0; i<=i1; i++) sum+= this.volume(i);  return sum; }//return i0<=i1 ? VOLUME(sum/(i1-i0+1)) : 0; }
	getSumTickVolume(i0 :number, i1 :number)   { let sum=0;  for (let i=i0; i<=i1; i++) sum+= this.tickVolume(i);  return sum; }//return i0<=i1 ? VOLUME(sum/(i1-i0+1)) : 0; }
}




export interface IBarsExt extends IBars {
	readonly lastBarClosed : boolean;
	readonly barInfo : (i :number)=>BarInfo;
}




//function ffff(bars : IBars) { for(let a of bars);   let gg : IBars;  gg= bars; }



export abstract class CBarsBase extends IBars
{
	protected _data : readonly CBar[];
	protected _ticksize? : number;
	public get _tickSize() { return this._ticksize; }
	//[Symbol.iterator]() { return this.data[Symbol.iterator](); }

	get data() : readonly CBar[] { return this._data; }

	get tickSize() : number { return this._ticksize ??= lib.MaxCommonDivisorOnArray(this.closes); }

	protected _Add(bars : readonly CBar[])  { this._data = this._data.concat(bars); }

	constructor(tf :TF,  bars :Iterable<CBar>,  tickSize? :number) { //isImmutable? : boolean) {
		//this._data= isImmutable && (bars instanceof Array)  ? bars  : [...bars];
		super(tf); //this.Tf= tf;
		this._ticksize= tickSize ? tickSize : 0;
		if (bars==null) bars=[];
		if (bars instanceof IBars) {
			if (tf != bars.Tf)
				this._data= bars.toBarsArray(tf) ?? [];
			else
				this._data= ! bars.Mutable ? bars.data : [...bars];
		}
		else this._data= [...bars];
		//console.assert(this._data!=null);
		//console.assert(this.data!=null);
	}

	static fromParsedJSON(data :ParsedUrlQueryInputMy<IBars>) {
		/*
		let dst= {}; //new CBars(TF.M1, []);
		Object.setPrototypeOf(dst, CBars.prototype);
		let src= JSON.parse(str, (key,val)=>
			(val instanceof Array ?  val.map((el)=>new CBar(new Date(el.time), el.open, el.high, el.low, el.close, el.volume))
				: key==Object.keys({IBars.prototype.Tf})[0] ? TF.get(val.name) : val));
		console.log(src);
		alert(src.Tf instanceof TF);
		return Object.assign(dst, src);
		*/
		//let data= JSON.parse(str);
		//console.log("!!!! ",data.bars.Tf);
		let d= data as unknown as CBars; //{[key in keyof CBars]};  // Задаём тип CBars, чтобы обращаться к именам свойств
		let tf= TF.fromSec(d.Tf.sec);  if (!tf) { console.assert(tf!=null);  throw("wrong TF"); }
		let obj= new CBars(tf, d._data.map((el)=>CBar.fromParsedJSON(el as unknown as typeof data[0]))); //new CBar(new Date(el.time as any), el.open, el.high, el.low, el.close, el.volume)));
		return obj;
	}
}


export type IBarsImmutable = IBars & { readonly Mutable : false; }; //Immutable<IBars>  //{ readonly isMutable : false; } & { [key in keyof IBars] : IBars[key] }


//------------------------------------------------

export class CBars extends CBarsBase implements IBarsImmutable
{
	constructor(tf :TF,  bars :readonly CBar[],  tickSize? :number) { super(tf, bars ??[], tickSize); }
	readonly Mutable = false;

	static createCopy(bars :IBars) { return new CBars(bars.Tf, bars.data, bars.tickSize); }

	static createCopyExt(bars :IBars, lastBarClosed :boolean) : IBarsExt {
		let obj= Object.assign(CBars.createCopy(bars), {
			lastBarClosed,
			barInfo : (i :number)=>CBars.createBarInfo(obj, i)
		});
		return obj;
	}

	static createBarInfo(bars :IBarsExt, i :number) : BarInfo {
		return {
			bar: bars.data[i] ?? (()=>{console.trace();throw("Wrong bar index: i="+i+" barsTotal="+bars.count)})(),
			index: i,
			closed: bars.lastBarClosed || i<bars.count-1,
			getAllBars :()=>bars
		}
	}
}

let x = [] as Array<number>; // readonly CBar[];

for(let fff of x) { }



//----------------------------------------

export abstract class CBarsMutableBase extends CBarsBase
{
	private _tickSizeAuto :boolean;

	public override get data() : CBar[] { return this._data as CBar[]; }

	constructor(tf :TF,  bars? :readonly CBar[],  tickSize? :number)  { super(tf, bars??[], tickSize);  this._tickSizeAuto= !tickSize; }
	//constructor(tf :TF,  tickSize? :number);                          //{ super(tf, bars, tickSize);  this._tickSizeAuto= !tickSize; }
	//constructor(tf :TF,  paramOne? :readonly CBar[]|number,  paramTwo? :number)  { super(tf, typeof paramOne!="number" ? bars, tickSize);  this._tickSizeAuto= !tickSize; }

	// Виртуальное свойство мутабельности
	//readonly Mutable = true;

	// Добавление баров в конец
	Add(Bars : readonly CBar[]|CBar) : void {
		let bars= Bars instanceof Array ? Bars : [Bars];
		if (! bars || bars.length==0) return;
		let time= bars[0].time;
		if (this.count>0 && time<=this.lastTime!) throw "Wrong bar time:  "+time+" <= "+this.lastTime;
		if (!this.data) this._data= [];
		for(let bar of bars) Object.freeze(bar);
		this.data.push(...bars); //this._Add(bars);
		if (this._tickSizeAuto) this._ticksize=0;
	}//{ this._data = this._data.concat(bars); } //= [...this._data, ...bars]; }
    // Добавление баров в конец
	push(bars : readonly CBar[]|CBar) { this.Add(bars); }
	// обновить последний бар или добавить новый
	updateLast(bar :CBar) {
        if (this.lastTime)
            if (bar.time.valueOf()==this.lastTime.valueOf()) {
                this.data[this.length-1]= {...bar};
                if (this._tickSizeAuto) this._ticksize=0;
                return;
            }
            else if (bar.time<this.lastTime) throw "Wrong bar time:  "+bar.time+" < "+this.lastTime;
        this.push(bar);
    }

	// Добавить тик в конец
	AddTick(tick : ITick) : boolean {
		if (! tick) return false;
		if (this.count>0 && tick.time<this.lastTime!) {
			console.error("Wrong tick time:  "+tick.time+" < "+this.lastTime);  return false;
		}
		let barTime= Period.StartTime(this.Tf, tick.time);
		let bar : CBar;
		let price= tick.price;
		let i= this.count;

		if (this.count>0 && barTime.valueOf()==this.lastTime!.valueOf()) {
			bar= this.last!;  i--;
			bar= new CBar(barTime, bar.open, Math.max(bar.high, price), Math.min(bar.low, price), price, bar.volume + tick.volume, bar.tickVolume+1);
		}
		else
			bar= new CBar(barTime, price, price, price, price, tick.volume, 1);
		//console.log(i, barTime==this.lastTime);
		if (!this._data) this._data= [];
		Object.freeze(bar);
		this.data[i]= bar;
		return true;
	}
	// Добавить тики в конец
	AddTicks(ticks : readonly ITick[]) : boolean  { for(let tick of ticks) if (! this.AddTick(tick)) return false;  return true; }

	// Клонирование объекта
	//static Clone(source : CBars) : CBarsMutable { return (source instanceof CBarsMutable) ? { ...(new CBarsMutable) } : new CBarsMutable(source.Tf, source.tickSize, source.data); }
}


export class CBarsMutable extends CBarsMutableBase
{
	// Виртуальное свойство мутабельности
	readonly Mutable = true;
}

export class CBarsMutableExt extends CBarsMutable implements IBarsExt {
	lastBarClosed = true;
	readonly barInfo : (i :number)=>BarInfo = (i)=>CBars.createBarInfo(this, i);
}


// Создание рандомных баров
export function CreateRandomBars(tf: TF,  startTime: const_Date,  endTime: const_Date,  startPrice? :number,  volatility? :number|`${number}%`, ticksize? :number)  : CBars;
// Создание рандомных баров
export function CreateRandomBars(tf: TF,  startTime: const_Date,  barsCount: number,  startPrice? :number,  volatility? :number|`${number}%`, ticksize? :number)  : CBars;

// Создание рандомных баров
export function CreateRandomBars(tf: TF,  startTime: const_Date, endTimeOrCount: const_Date|number,  startPrice :number =100,  volatility :number|`${number}%`= "1%", tickSize? :number)  : CBars|null
{
	if (! tf || tf.msec==0) return null;
	console.log("Creating bars with parameters: ",...([...arguments].map(arg => arg instanceof TF ? arg.name : arg)));
    //tickSize ??= 10 ** Math.round(Math.log10(startPrice)-4);
    const tickSizeNum = tickSize ?? 10 ** Math.min( Math.round(Math.log10(startPrice)-4), 0 );
	//let endTime : const_Date;
	let period= new Period(tf);
    let count : number;
	if (typeof endTimeOrCount=="number")
		count = endTimeOrCount;
	//endTime = new Period(tf).span()
	else count= period.IndexFromTime(endTimeOrCount) - period.IndexFromTime(startTime) + 1;
	console.log(count);
	if (count<0) return null;
	let bars = new Array<CBar>(count);
	let price= startPrice;
	let periodSpan= period.span(startTime);
    let digits= GetDblPrecision(tickSizeNum);

	function norm(value :number) { return NormalizeDouble(Math.round(value/tickSizeNum)*tickSizeNum, digits); }// lib.NormalizeDouble(value, )}
	const [volatFactor, volatNum]= typeof volatility=="string" ? [Number(volatility.slice(0, -1))/100, undefined] : [undefined, volatility];
    //let volatilityNum= typeof volatility=="string" ? undefined

	for (let i=0; i<count; i++) {
        const volat= volatNum ?? volatFactor * price;
		let open= norm( price + (Math.random()*2-1) * volat/10 );
		let high= norm( open + Math.random() * volat );
		let low= norm( open - Math.random() * volat );
		let close= norm( low + Math.random() * (high - low) );
		let volume= tf.msec;
		let time= periodSpan.startTime;
		let bar= new CBar(time, open, high, low, close, volume, volume);
		bars[i]= bar;
		periodSpan = periodSpan.next()
		price= close;
	}
	return new CBars(tf, bars);
}






//export class TimeValue<T> { readonly time :const_Date;  readonly value :T };

export type TimeValue<T> = { readonly time :const_Date;  readonly value :T };



export interface ITimeseries<T=number> extends IItems<Readonly<TimeValue<T>>>
{
	time(i :number) : const_Date;
	value(i :number) : T;
	readonly times : IItems<const_Date>;
	readonly values : IItems<T>;

	indexOf(time :const_Date, match? :SearchMatchMode) : number;// { lib.BSearch();}
}


//import {Immutable, Readonly} from "./BaseTypes";




export abstract class CTimeSeriesBase<T=number> implements ITimeseries<T>
{
	abstract get points() : readonly TimeValue<T>[];
	abstract get name() : string|undefined;
	time(i :number) : const_Date { return this.points[i]?.time ?? (()=>{throw "Wrong index i="+i+" of "+this.length})(); }
	value(i :number) : T         { return this.points[i]?.value ?? (()=>{throw "Wrong index i="+i+" of "+this.length})(); }
	get last() : TimeValue<T>|undefined  { return this.points.at(-1); }
	get times() : IItems<const_Date> { return new lib.VirtualItems((i)=>this.time(i), ()=>this.length); }
	get values() : IItems<T>         { return new lib.VirtualItems((i)=>this.value(i), ()=>this.length); }
	get length() { return this.points.length; }

	indexOf(time :const_Date, match? :SearchMatchMode) { return BSearch(this.times, time, match); }// { lib.BSearch();}

	protected constructor() { //name? :string, points? :readonly TimeValue<T>[]) {
		return CreateArrayProxy(this, (i)=>this.points[i]);
	}
	[Symbol.iterator]() { return this.points[Symbol.iterator](); }
	readonly [key : number] : Readonly<TimeValue<T>>;
}



export class CTimeSeries<T=number> extends CTimeSeriesBase<T>
{
	points : TimeValue<T>[]= [];
	name : string|undefined;

	constructor(name? :string, points? :readonly TimeValue<T>[]) {
		super();
		this.name= name;  this.points= points ? [...points] : [];
	}

	//static fromParsedJSON2<T extends never>(data : ParsedUrlQueryInputMy<CTimeSeries<T>>) : CTimeSeries<T> { return { } }

	static fromParsedJSON<T extends never>(data : ParsedUrlQueryInputMy<CTimeSeries<T>>) : CTimeSeries< ParsedUrlQueryInputMy<T> >;
	static fromParsedJSON<T extends null|undefined>(data : T) : T;
	static fromParsedJSON<T extends never>(data : ParsedUrlQueryInputMy<CTimeSeries<T>>|null|undefined) {
		if (!data) return data;
		let obj = new CTimeSeries< ParsedUrlQueryInputMy<T> >();
		console.assert(data.points!=null); //if (!data.points) return null; //console.log(data);
		//obj.points[0]= { time : new Date, value: data.points[0].value as TT };
		//let fff = obj.points[0].value;
		obj.name= data.name;  obj.points= data.points.map((pnt)=>{ return {time: new Date(pnt.time), value: (pnt as any).value }; });
		return obj;
	}

	//aaaa= CTimeSeries.fromParsedJSON( { } as ParsedUrlQueryInputMy<CTimeSeries<number>> );


	write(stream :ByteStreamW,  valueWriter :((stream :ByteStreamW, value:T)=>boolean|void)) :boolean;

	write(stream :ByteStreamW,  valueType : T extends number ? NumericTypes|Nullable<NumericTypes> : never) :boolean;

	write(stream :ByteStreamW,  arg :((stream :ByteStreamW, value:T)=>boolean|void) | (T extends number ? NumericTypes|Nullable<NumericTypes> : never)) :boolean
	{
		let valueWriter= (typeof arg=="function") ?  arg :  (stream :ByteStreamW, value :T)=>stream.pushNumber(value as unknown as number, arg as NumericTypes);
		function _writePoint(stream :ByteStreamW, pair :TimeValue<T>) { return stream.pushInt64(pair.time.valueOf())!=null && valueWriter(stream, pair.value)!=false; }
		return stream.pushUnicode(this.name ?? null).pushArrayByFunc(this.points, _writePoint) != null;
	}

	static read<T extends NumericTypes|Nullable<NumericTypes>>(stream :ByteStreamR,  type :T) : T extends NumericTypes ? CTimeSeries<number> : CTimeSeries<number|null>;

	static read<T> (stream :ByteStreamR,  valueGetter :(stream :ByteStreamR)=>T) : CTimeSeries<T>;

	static read<T>(stream :ByteStreamR, arg :((stream :ByteStreamR)=>T)|NumericTypes|Nullable<NumericTypes>) : CTimeSeries<T> {
		let valueGetter= (typeof arg=="function") ?  arg :  (stream :ByteStreamR)=>stream.readNumber(arg as NumericTypes);
		let name= stream.readUnicode();
		let points = stream.readArray((stream)=> ({time: new Date(stream.readUint64()),  value: valueGetter(stream) as T}));
		return new CTimeSeries(name ?? undefined, points);
	}

		//if (typeof this.points[0].value=="number")
	/*
	static toBinary<T extends {[key in keyof T]: number} | { toBinary();}>  (obj : CTimeSeries<T>)  : DataView {
		//if (obj.points[0]. );
		let stream= new ByteStreamW();
		stream.pushArray(points).pushUnicode(name);
		//view.byteLength= 100;
		//buffer.
	}
	*/
}

export type CTimeSeriesReadonly<T> = ReadonlyFull<CTimeSeries<T>>;


function _findBars(srcBars: readonly CBar[], barsToFind: readonly CBar[], mode: "deep" | "shallow"): number {
    let len = barsToFind.length;
    if (srcBars.length < len || len == -1) return -1;
    let start = 0;
    let end = len - 1;
    let iStart = BSearch(srcBars, barsToFind[start].time, (bar, time) => bar.time.valueOf() - time.valueOf());
    let iEnd = BSearch(srcBars, barsToFind[end].time, (bar, time) => bar.time.valueOf() - time.valueOf());
    //console.log(iStart, iEnd, iEnd-iStart+1, len);
    if (iStart < 0 || iEnd < 0 || iEnd - iStart + 1 != len) return -1;
    let delta = start - iStart;
    if (mode == "deep") {
        for (let i = iStart; i <= iEnd; i++)
            if (!deepEqual(srcBars[i], barsToFind[i + delta]))
                return -1;
    } else
        for (let i = iStart; i <= iEnd; i++)
            if (srcBars[i] != barsToFind[i + delta])
                return -1;
    return iStart;
}

function findBarsDeep(srcBars: readonly CBar[], barsToFind: readonly CBar[]): number {
    return _findBars(srcBars, barsToFind, "deep");
}

//let z= new CTimeSeries<number>();
export function findBarsShallow(srcBars: readonly CBar[], barsToFind: readonly CBar[]): number {
    return _findBars(srcBars, barsToFind, "shallow");
}
