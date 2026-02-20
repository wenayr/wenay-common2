import * as lib from "../Common/common";
import {E_MATCH, MyNumMap, ParsedUrlQueryInputMy} from "../Common/common";
import {
	CBar,
	CBars,
	CBarsMutable,
	CBarsMutableBase,
	IBars,
	IBarsImmutable,
	ITick,
	MinTime,
	Period,
	TF,
	TFIndex
} from "./Bars";
import {const_Date} from "../Common/BaseTypes";
//import type {ParsedUrlQueryInputMy} from "./querystringMy";

export * from "./Bars";

/*
class CTick
{
	ask : number;
	bid : number;
	last : number;
}
*/


//function f(arg : MyMap<number, string>) { }

//f(new MyNumMap<string>());


//new MyMap<number, string>();
//----------------------------------------


class CBarsInternal extends CBarsMutableBase
{
	override set data(bars : CBar[]) { this._data= bars;  console.assert(bars!=null); }
	override get data() : CBar[] 	{ return this._data as CBar[]; }  // не убирать парный метод, иначе будет баг (get метод будет возвращать null)!
	override set tickSize(value : number) { this._ticksize= value; }
	override get tickSize() : number { return this._ticksize ?? 0; }  // не убирать парный метод, иначе будет баг (get метод будет возвращать null)!
	Mutable : boolean = true; // private _isMutable : boolean; //get isMutable()         { return this._isMutable; } set isMutable(val : boolean) { this._isMutable= val; }
	//referred : boolean = false;
	constructor(tf :TF,  bars? : readonly CBar[],  tickSize : number =0) { super(tf, bars, tickSize); }

	static newFrom(other : IBars) { return new CBarsInternal(other.Tf, other.data, other.tickSize); }
}


type TBarsInfo = { bars :IBars,  modifyInfo? : { id :number, time :const_Date, srcTf :TF } };


//-----------------------------
//class CBarsInfoMap extends MyNumMap<TBarsInfo>  { Bars(tf :TF) : IBars { return this[tf.index]} }



export class CQuotesHistory
{
	protected _modifyCounter = 0;

	readonly [key:number] : void;

	//protected barsMap : MyNumMap<IBars> = new MyNumMap();  //Map<number, CBars>;// : set<CBars>;//[];

	protected barsMainMap : MyNumMap<IBars> = new MyNumMap();

	protected barsInfoMap : MyNumMap<TBarsInfo> = new MyNumMap();

	//protected _outDatas : CBars[] = new Array<CBars>(100);

	protected _ticksize? : number;

	protected _minTf? : TF|null;

	protected _GetTickSize() : number { let val=0;  for(let bars of this.barsMainMap.Values) val= lib.MaxCommonDivisor(bars.tickSize, val);  return val; }

	//--------------------------------------------------
	readonly name? : string;

	//toJSON() { return JSON.stringify(this.barsMainMap.Values);  }

	static fromParsedJSON(data :ParsedUrlQueryInputMy) {
		let d= data as unknown as CQuotesHistory;
		let map = Object.assign(new MyNumMap(), {...d.barsMainMap}) as MyNumMap<ParsedUrlQueryInputMy<IBars>> //typeof d.barsMainMap;
                
		return new CQuotesHistory(map.Values.map((bars)=>CBars.fromParsedJSON(bars)), d.name);
	}

	//readonly id :symbol = Symbol();

	get stateID() { return this._modifyCounter; }  // Идентификатор состояния (счётчик модификаций объекта)

	get minTf() : TF|null { if (!this._minTf) this._minTf= TF.min(...this.mainDatas.map(bars=>bars.Tf));  return this._minTf; }//return this._minTf; };  // Минимальный таймфрейм

	get minTfBars() : IBarsImmutable|null { return this.minTf ? this.Bars(this.minTf) : null; }

	minTfForTime(time :const_Date) : TF|null { for(let bars of this.barsMainMap.Values) if (bars.length >0 && bars.time(0)<=time) return bars.Tf;  return null; }

	minTfBarsForTime(time :const_Date) : IBars|null { let tf= this.minTfForTime(time);  return tf ? this._Bars(tf) : null; }

	get tickSize()  { if (! this._ticksize) this._ticksize= this._GetTickSize();  return this._ticksize; }  // Размер тика

	get mainDatas()  :readonly IBars[]  { return this.barsMainMap.Values; }  // Главные баровые таймсерии (создаваемые пользователем)

	get isMutable() { return false; }


	constructor(Datas :readonly IBars[]|IBars, name? :string)
	{
		//console.log(Datas.length);
		let datas : readonly IBars[] = (Datas instanceof IBars ? [Datas] : Datas) ;
		let datasMy= [];  // Заполняем иммутабельными элементами
		for(let bars of datas) if (bars) datasMy.push( bars.Mutable ? CBarsInternal.newFrom(bars) : bars );
		for(let bars of datasMy) { this.barsInfoMap[bars.Tf.index]= {bars : bars};  this.barsMainMap[bars.Tf.index]= bars; } //this.barsMap[bars.Tf.index]= bars;   //if (this._minTf==null || bars.Tf<this._minTf) this._minTf= bars.Tf;
		//console.log("!!! ",this.barsInfoMap.Count()); //this.mainDatas);
		//this.barsMainMap= this.barsMap.Clone(); //[...datas];
		if (name) this.name= name;
	}

	protected _OnModify(tf :TF,  startTime :const_Date,  endTime :const_Date,  toEnd :boolean)
	{
		let infos= this.barsInfoMap.Values;
		this._modifyCounter++;
		let modifyCount= this._modifyCounter;
		// Перебираем старшие таймфреймы и записываем инфу об изменениях, а также удаляем младшие таймфреймы
		for(let i= infos.length-1;  i>=0;  i--)  {
			let info= infos[i];
			let barsTf= info.bars.Tf;
			if (barsTf > tf) // записываем инфу об изменениях в старший таймфрейм
				info.modifyInfo= {
					time : MinTime(startTime, info.modifyInfo?.time), // ((a, b?) => (!b || a < b  ? a  : b)) (startTime, info.modifyInfo?.time),  // Меньшее время
					srcTf : tf,
					id : modifyCount
				};
			else if (barsTf<tf && info.bars.count>0) { // удаляем бары с младших таймфреймов
				//console.log(startTime, endTime); //barsTf.name);
				let [barsStartTime, barsEndTime] = toEnd ? [null,  new Period(tf).span(startTime).prev().endTime] : [new Period(tf).span(endTime).next().startTime,  null];
				if (!barsStartTime || barsStartTime<=info.bars.time(0))
					if (!barsEndTime || barsEndTime>=info.bars.lastTime!)
						continue;
				let barsArr= info.bars.getArray(barsStartTime, barsEndTime);
				//console.log(new Period(tf).span(endTime).next().startTime);
				//console.log(barsArr);
				let bars= barsArr && barsArr.length>0 ?  new CBars(barsTf, barsArr, info.bars.tickSize) :  undefined;
				if (bars) {
					this.barsInfoMap[barsTf.index]!.bars= bars;
					//this.barsMap[barsTf.index]= bars;
					//console.log(this.barsInfoMap[barsTf.index].bars);
					this.barsMainMap[barsTf.index]= bars;
				}
				else {
					this.barsInfoMap.Remove(barsTf.index);
					//this.barsMap.Remove(barsTf.index);
					this.barsMainMap.Remove(barsTf.index);
				}
			}
		}
		this._ticksize= 0;
		//this._minTf= null;
		this._minTf= null; //TF.min(this._minTf, tf);
	}


	protected _CombineBars(myBars :IBars, newBars :readonly CBar[]|CBar, startTime :const_Date, endtime? :const_Date) : IBars
	{
		//console.log(startTime, endtime);
		if (!newBars) return myBars;
		let ibar= myBars.indexOf(startTime, E_MATCH.GREAT_OR_EQUAL);
		if (ibar==-1) ibar= myBars.count;
		//let newbars :readonly CBar[] = (newBars instanceof Array) ? newBars : [newBars];
		let lastBars : CBar[] = [];
		if (endtime) {
			let ilast= myBars.indexOf(endtime, E_MATCH.LESS_OR_EQUAL)+1;
			lastBars= myBars.data.slice(ilast, myBars.length);
		} //let ibarEnd= myBars.IndexOf(newbars[newbars.length-1].time, E_MATCH.LESS_OR_EQUAL);
		let resultBars : CBarsInternal; // //lib.dynamic_cast<CBarsInternal>(myBars);
		if (myBars instanceof CBarsInternal && myBars.Mutable)
			(resultBars= myBars).data.splice(ibar);  // удаляем конечные бары, начиная с ibar
		else
			resultBars= new CBarsInternal(myBars.Tf, myBars.data.slice(0, ibar), myBars.tickSize);  // копируем начальные бары
		//console.log(newbars.length, lastBars.length);
		//console.log(startTime, ibar);
		//resultBars.data.push(...newbars, ...lastBars); // приводит к переполнению стека
		resultBars.data= resultBars.data.concat(newBars, lastBars);
		return resultBars;
	}


	protected _CreateUpdatedBars(myBars :IBars, updatedBars :IBars, startTime :const_Date) : IBars
	{
		startTime= Period.StartTime(myBars.Tf, startTime);
		let addedBarsArr = updatedBars.getArray(startTime);
		let addedBarsArrConverted= new CBars(updatedBars.Tf, addedBarsArr ??[]).toBarsArray(myBars.Tf);
		return this._CombineBars(myBars, addedBarsArrConverted, startTime);
	}
	// Индекс ближайшего меньшего таймфрейма
	private _getLessTf(tf :TF) : TF|null {
		//console.log("tfIndex="+tf?.index,  "indexes="+this.barsInfoMap.sortedKeys.join());
		let i= lib.BSearch(this.barsInfoMap.sortedKeys, tf.index-1, E_MATCH.LESS_OR_EQUAL);
		return (i>=0) ? TF.all[this.barsInfoMap.sortedKeys[i]] : null;
	}


	protected _BuildNewBars(tf :TF) : CBarsInternal|null {
		// Находим ближайший меньший таймфрейм для построения    //, .findIndex((key)=> key > tf.index) - 1;
		let lessTf= this._getLessTf(tf);
		//console.log("!!! ",lib.BSearchDefault(this._barsInfoMap.sortedKeys, TF.H6.index-1, E_MATCH.LESS_OR_EQUAL);
		if (lessTf==null) return null;
		let info= this.barsInfoMap[lessTf.index]!;
		//console.log(this._barsInfoMap.sortedKeys);
		let bars= info.modifyInfo ? this._Bars(info.modifyInfo.srcTf) : info.bars;
		//let bars= this.barsMap[this.barsMap.sortedKeys[i]];
		let newbars= bars.toBarsArray(tf);
		//console.assert(newbars!=null);
		if (! newbars) { console.log(`Failed to create bars ${tf.name} from ${bars.Tf.name}`);  return null; }

		return new CBarsInternal(tf, newbars, this.tickSize);
	}


	private _Bars(tf : TF|TFIndex) : IBars  { return this.barsInfoMap[typeof tf=="number" ? tf : tf.index]!.bars; }


	protected _GetBars(tf :TF) : IBars|null
	{
		if (! tf) throw "undefined timeframe!";
		let Info = this.barsInfoMap[tf.index];
		let updated= false;
		let bars;
		if (Info) {
			if (Info.modifyInfo) {
				//console.log("Info:\n",Info);
				// let srcTf= Info.modifyInfo.srcTf;
				// bars = this._CreateUpdatedBars(Info.bars, this._Bars(srcTf), Info.modifyInfo.time);
				let srcTf= this._getLessTf(tf);
				//console.log(tf.index,"   ",this.barsMainMap.sortedKeys);
				//console.log("Tfs:",this.mainDatas.map(bars=>bars.Tf.name));
				//console.log(srcTf);
				if (!srcTf) return null;
				bars = this._CreateUpdatedBars(Info.bars, this._GetBars(srcTf) ?? (()=>{throw "null bars!";})(), Info.modifyInfo.time);
				updated= true;
				//this.OnModify(tf, Info.modifyInfo.time, Info.modifyInfo.id);
				Info.modifyInfo= undefined;
				//console.log("Modified bars:\n",bars);
			}
			else bars = Info.bars;
		} else {
			bars = this._BuildNewBars(tf);
			if (!bars) return null;
			updated= true;
			Info = { bars: bars };
			this.barsInfoMap[tf.index]= Info;
			//this.OnModify(tf, Info.modifyInfo.time, Info.modifyInfo.id);
		}
		if (updated) {
			// Меняем у всех старших таймсерий модифицирующий таймфрейм на текущий (будем строить из него)
			for (let i = this.barsInfoMap.Values.length-1; i>=0; i--) {
				let info = this.barsInfoMap.Values[i];
				if (info.bars.Tf <= tf) break;
				if (info.modifyInfo) info.modifyInfo.srcTf = tf;
			}
		}
		if (bars!=Info.bars) { Info.bars= bars;  this.barsMainMap[tf.index] ??= bars; } //this.barsMap[tf.index] = bars;
		return bars;
	}

	//-----
	public Bars(tf :TF) : IBarsImmutable|null
	{
		let bars= this._GetBars(tf);
		if (bars instanceof CBarsInternal)
			bars.Mutable= false;  // Получена ссылка на объект
		return bars as IBarsImmutable|null;
	}

	/*
		{  return Info.bars; }
		//let i= BSearchDefault(this._barsInfoMap.sortedKeys, tf.index-1, E_MATCH.LESS_OR_EQUAL);

		let maxId= 0;
		let foundInfo : TBarsInfo;
		for(let info of this._barsInfoMap.Values)  // перебираем инфу по младшим таймфреймам и находим самую позднюю модификацию
			if (info.bars.Tf<tf) {
				if (foundInfo)
					if (info.modifyId< foundInfo.modifyId)  // более ранняя модификация для старшего таймфрейма уже неактуальна
						this._barsInfoMap.Remove(info.bars.Tf.index);
					else
				maxId= Math.max(info.modifyId, maxId);
			}
			else break;

	}
	*/
	/*
	protected SetBarsMutable(tf :TF) : CBarsMutable {
		if (! this._outDatas[tf.index]) { // Если ещё не были запрошены эти бары  //return this.barsDatas[tf.index];
			let bars= this.barsDatasMap[tf.index];
			if (bars)
				if (bars.isMutable) return bars as CBarsMutable;
				else { bars= (bars as CBarsMutable).clone();  this.barsDatasMap[tf.index]= }
				return bars.isMutable ? bars : {...bars};
		}
	}
	*/

}
//----------------------------------

export class CQuotesHistoryMutable extends CQuotesHistory
{
	private _endTickTime? : const_Date;
	override get isMutable() { return true; }

	constructor(name?: string) {
		super([], name);
	}
	// Добавить бары в конец
	public AddEndBars(bars: IBars) : boolean;
	// Добавить бары в конец
	public AddEndBars(bars: readonly CBar[]|CBar, tf: TF) : boolean;
	// Добавить бары в конец
	public AddEndBars(bars: readonly CBar[]|CBar|IBars, tf?: TF) : boolean { return this._AddBarsExt(bars, tf, true); }

	// Добавить бары в начало
	public AddStartBars(bars: IBars) : boolean;
	// Добавить бары в начало
	public AddStartBars(bars: readonly CBar[]|CBar,  tf: TF) : boolean;
	// Добавить бары в начало
	public AddStartBars(bars: readonly CBar[]|CBar|IBars,  tf?: TF) : boolean { return this._AddBarsExt(bars, tf, false); }

	private checkBars(bars :readonly CBar[], tf :TF)  {
		let period= new Period(tf);
		for (let i=1; i<bars.length; i++)
			if (! bars[i]) { console.log("Отсутствует бар №"+i);  return false; }
			else
			if (bars[i].time.valueOf() - bars[i-1].time.valueOf() < tf.msec  &&  period.span(bars[i].time).index <= period.span(bars[i-1].time).index) {
				console.log("Некорректное время бара №"+i+":",bars[i].time,"  Предыдущее время:",bars[i-1].time);
				return false;
			}
		return true;
	}

	protected _AddBarsExt(Bars: readonly CBar[]|CBar|IBars,  tf: TF|undefined,  toEnd: boolean) : boolean
	{
		if (!Bars) return false;
		let bars :readonly CBar[] = Bars instanceof IBars ? Bars.data : Bars instanceof Array ? Bars : [Bars];
		//console.log(Bars instanceof CBar);
		//let asBars = dynamic_cast<CBar[]>(bars);
		if (bars.length==0) return true; //if (asBars && asBars.length==0) return;
		if (Bars instanceof IBars) tf= Bars.Tf;
		else if (!this.checkBars(bars, tf!)) return false;
		if (! tf) return false;
		//AddBarsFirst();
		//AddBarsLast()
		let oldBars0 = this._GetBars(tf);
		//console.log(new CBarsInternal(tf).data!=null);
		let oldBars= oldBars0 ?? new CBarsInternal(tf);

		let time = bars[0].time;  //asBars ? asBars[0].time : (bars as CBar).time;
		let endtime= bars[bars.length-1].time;

		if (oldBars.count>0)
			if (!toEnd) { if (oldBars.time(0)<time) time= oldBars.time(0); }
			else        { if (oldBars.lastTime!>endtime) endtime= oldBars.lastTime!; }

		//console.log(time, endtime);
		let resultBars = this._CombineBars(oldBars, bars, time, endtime); //new CBarsInternal(tf, this.tickSize, (myBars ? myBars.data : []).concat(bars));
		//console.log("!",resultBars," finish");
		//return;
		if (! resultBars) return false;

		if (resultBars != oldBars0) {
			//this.barsMap[tf.index] = resultBars;
			this.barsInfoMap[tf.index]= { bars: resultBars };  //else this._barsInfoMap[tf.index].bars = resultBars;
		}
		this.barsMainMap[tf.index]= resultBars;
		this._OnModify(tf, time, endtime, toEnd);
		if (! this._endTickTime || toEnd || bars[bars.length-1].time>=Period.StartTime(tf, this._endTickTime))
			this._endTickTime= new Date(resultBars.lastTime!.valueOf()+1); //MaxTime(this._endTickTime, resultBars.lastTime);
		return true;
	}

	// Добавить тики в конец, с возможностью замены предыдущих  баров
	public AddTicks(ticks : readonly ITick[]) : boolean
	{
		if (!ticks || ticks.length==0) return true;
		let time= ticks[0].time;
		let tf= TF.S1;
		let oldBars = this._GetBars(tf);
		let newbarsArr : readonly CBar[]|undefined;
		if (oldBars && oldBars.count>0 && Period.StartTime(tf,time)==oldBars.lastTime)
			newbarsArr= [oldBars.last!];
		let newbars = new CBarsMutable(tf, newbarsArr); //oldBars.getArray(Period.StartTime(tf,time), ));
		if (!newbars.AddTicks(ticks)) return false;
		this._endTickTime= ticks[ticks.length-1].time;
		return this.AddEndBars(newbars);
	}


	public AddTick(tick : ITick) { return this.AddTicks([tick]); }

	private getOrSetMutableBars(tf :TF) {
		let bars= this._GetBars(tf) ?? new CBarsInternal(tf);  //if (! bars) throw "bars is null!";
		let mutableBars : CBarsInternal;
		//console.log("!!! ",tf.name);
		if (! (bars instanceof CBarsInternal) || ! bars.Mutable) {
			mutableBars= new CBarsInternal(bars.Tf, bars.data, bars.tickSize);
			this.barsMainMap[tf.index]= mutableBars;
			this.barsInfoMap[tf.index]!.bars= mutableBars;
		}
		else mutableBars= bars;
		return mutableBars;
	}


	// Добавить новые тики в конец, БЕЗ возможности замены предыдущих баров! (выдаст ошибку)
	public AddNewTicks(ticks : readonly ITick[]) {
		if (ticks.length==0) return;
		if (this._endTickTime && ticks[0].time < this._endTickTime) throw "Время тика меньше предыдущего!";
		let tfIndexes= this.barsInfoMap.sortedKeys;
		if (tfIndexes[0] > TF.S1.index) tfIndexes= [TF.S1.index, ...tfIndexes];
		for(let tfVal of tfIndexes) {
			let tf= TF.all[tfVal];
			let mutableBars = this.getOrSetMutableBars(tf);
			mutableBars.AddTicks(ticks);
		}
		this._modifyCounter++;
		this._endTickTime= ticks[ticks.length-1].time;
	}

	public AddNewTick(tick :ITick) { return this.AddNewTicks([tick]); }

	public deleteBefore(time :const_Date) {
		time= new Date(time.valueOf()-1);
		// for(let bars of this.barsMainMap.Values) {
		// 	if (bars.length>0)
		// 		if (bars.firstTime! <=time && time<=bars.lastCloseTime!) {
		// 			let i= bars.indexOf(time,"greatOrEqual");
		// 			console.assert(i!=-1, "i==-1 for time "+time.toString());
		// 			console.log("Задаём начальный бар",bars.Tf.name,bars[i]);
		// 			this.AddStartBars(bars[i], bars.Tf);
		// 			break;
		// 		}
		// }
		for(let {bars} of this.barsInfoMap.Values) {
			if (bars.firstTime! <=time && time<=bars.lastCloseTime!) {
				let mutableBars= this.getOrSetMutableBars(bars.Tf);
				let i= bars.indexOf(time,"greatOrEqual");
				console.assert(i!=-1, "i==-1 for time "+time.toString());
				mutableBars.data.splice(0,i+1);
			}
		}
		this._modifyCounter++;
	}

	/*
	public AddFrom(other :CQuotesHistory) {
		for (let bars in other.mainDatas)
	}*/
};


//====================================

export class CQuotesHistoryMutable2 extends CQuotesHistory
{
	//private _sourceId : symbol;
	private _source? : CQuotesHistory;
	private _time? : const_Date;
	private _sourceCounter= 0;
	override get tickSize() { return this._source?.tickSize ?? 0; } //protected _GetTickSize() { return this._source.TickSize; }
	override get minTf()    { return this._source?.minTf ?? null; }

	override get isMutable() { return true; }

	constructor(name: string) {
		super([], name);
	}

	protected _CreateNewBars(tf : TF) {
		let srcBars= this._source?.Bars(tf);  if (!srcBars) return null;
		let istop= this._time ? srcBars.indexOf(this._time, E_MATCH.GREAT_OR_EQUAL) : srcBars.length;
		let slicedBars :CBar[] = srcBars.data.slice(0, istop);  // Выбираем istop начальных баров
		return new CBarsInternal(tf, slicedBars);
	}


	// Присвоить бары с другого объекта
	public Update(other :CQuotesHistory, endTime? : const_Date)
	{
		let isUpdate = other==this._source && other.stateID==this._sourceCounter; // endTime>=this._time;
		//for(let bars of this.barsMap.Values) {
		for(let info of this.barsInfoMap.Values) {
			let bars= info.bars;
			let srcBars= other.Bars(bars.Tf);  if (!srcBars) continue;
			let start= 0;
			if (isUpdate && (endTime && this._time ? endTime>=this._time : endTime==this._time))
				start= bars.data.length;
			let stop= endTime ? srcBars.indexOf(endTime, E_MATCH.GREAT_OR_EQUAL) : srcBars.length;
			let newbarsArr= srcBars.data.slice(start, stop);
			let resultbarsArr= start>0 ? [...bars.data, ...newbarsArr] : newbarsArr;
			let resultBars= new CBars(bars.Tf, resultbarsArr, bars.tickSize);
			//this.barsMap[bars.Tf.index]= resultBars;
			info.bars= resultBars;
			if (this.barsMainMap[bars.Tf.index])
				this.barsMainMap[bars.Tf.index]= resultBars;
		}/*
		if (!isUpdate) {
			this._sourceId = other.id;
			this._minTf= other.minTf;
			this._ticksize= other.tickSize;
		}*/
		this._source = other;
		this._sourceCounter = other.stateID;
		this._time = endTime;  //this.minTf= other.minTf;
		this._modifyCounter++;
	}

}


/*
class A {
  value : number;
  constructor(value) { this.value= value; }
}

class B
{
	private a : A;
	constructor(a : A) { this.a= a; }

	value() { return this.a.value; }
}
//function GetEnumKeys(T) : readonly string[] { return Object.keys(T).filter(k => typeof T[k as any] === "number"); }

function main()
{
	let a= new A(1);

	let b= new B(a);

	console.log(b.value());

	a.value= 2

	console.log(b.value());
}

main();
*/
export {deepEqual} from "../Common/common";