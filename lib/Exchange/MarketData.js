"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CQuotesHistoryMutable2 = exports.CQuotesHistoryMutable = exports.CQuotesHistory = void 0;
const Bars_1 = require("./Bars");
const common_1 = require("../Common/core/common");
__exportStar(require("./Bars"), exports);
class CBarsInternal extends Bars_1.CBarsMutableBase {
    set data(bars) { this._data = bars; console.assert(bars != null); }
    get data() { return this._data; }
    set tickSize(value) { this._ticksize = value; }
    get tickSize() { return this._ticksize ?? 0; }
    Mutable = true;
    constructor(tf, bars, tickSize = 0) { super(tf, bars, tickSize); }
    static newFrom(other) { return new CBarsInternal(other.Tf, other.data, other.tickSize); }
}
class CQuotesHistory {
    _modifyCounter = 0;
    barsMainMap = new common_1.MyNumMap();
    barsInfoMap = new common_1.MyNumMap();
    _ticksize;
    _minTf;
    _GetTickSize() { let val = 0; for (let bars of this.barsMainMap.Values)
        val = (0, common_1.MaxCommonDivisor)(bars.tickSize, val); return val; }
    name;
    static fromParsedJSON(data) {
        let d = data;
        let map = Object.assign(new common_1.MyNumMap(), { ...d.barsMainMap });
        return new CQuotesHistory(map.Values.map((bars) => Bars_1.CBars.fromParsedJSON(bars)), d.name);
    }
    get stateID() { return this._modifyCounter; }
    get minTf() { if (!this._minTf)
        this._minTf = Bars_1.TF.min(...this.mainDatas.map(bars => bars.Tf)); return this._minTf; }
    get minTfBars() { return this.minTf ? this.Bars(this.minTf) : null; }
    minTfForTime(time) { for (let bars of this.barsMainMap.Values)
        if (bars.length > 0 && bars.time(0) <= time)
            return bars.Tf; return null; }
    minTfBarsForTime(time) { let tf = this.minTfForTime(time); return tf ? this._Bars(tf) : null; }
    get tickSize() { if (!this._ticksize)
        this._ticksize = this._GetTickSize(); return this._ticksize; }
    get mainDatas() { return this.barsMainMap.Values; }
    get isMutable() { return false; }
    constructor(Datas, name) {
        let datas = (Datas instanceof Bars_1.IBars ? [Datas] : Datas);
        let datasMy = [];
        for (let bars of datas)
            if (bars)
                datasMy.push(bars.Mutable ? CBarsInternal.newFrom(bars) : bars);
        for (let bars of datasMy) {
            this.barsInfoMap[bars.Tf.index] = { bars: bars };
            this.barsMainMap[bars.Tf.index] = bars;
        }
        if (name)
            this.name = name;
    }
    _OnModify(tf, startTime, endTime, toEnd) {
        let infos = this.barsInfoMap.Values;
        this._modifyCounter++;
        let modifyCount = this._modifyCounter;
        for (let i = infos.length - 1; i >= 0; i--) {
            let info = infos[i];
            let barsTf = info.bars.Tf;
            if (barsTf > tf)
                info.modifyInfo = {
                    time: (0, Bars_1.MinTime)(startTime, info.modifyInfo?.time),
                    srcTf: tf,
                    id: modifyCount
                };
            else if (barsTf < tf && info.bars.count > 0) {
                let [barsStartTime, barsEndTime] = toEnd ? [null, new Bars_1.Period(tf).span(startTime).prev().endTime] : [new Bars_1.Period(tf).span(endTime).next().startTime, null];
                if (!barsStartTime || barsStartTime <= info.bars.time(0))
                    if (!barsEndTime || barsEndTime >= info.bars.lastTime)
                        continue;
                let barsArr = info.bars.getArray(barsStartTime, barsEndTime);
                let bars = barsArr && barsArr.length > 0 ? new Bars_1.CBars(barsTf, barsArr, info.bars.tickSize) : undefined;
                if (bars) {
                    this.barsInfoMap[barsTf.index].bars = bars;
                    this.barsMainMap[barsTf.index] = bars;
                }
                else {
                    this.barsInfoMap.Remove(barsTf.index);
                    this.barsMainMap.Remove(barsTf.index);
                }
            }
        }
        this._ticksize = 0;
        this._minTf = null;
    }
    _CombineBars(myBars, newBars, startTime, endtime) {
        if (!newBars)
            return myBars;
        let ibar = myBars.indexOf(startTime, common_1.E_MATCH.GREAT_OR_EQUAL);
        if (ibar == -1)
            ibar = myBars.count;
        let lastBars = [];
        if (endtime) {
            let ilast = myBars.indexOf(endtime, common_1.E_MATCH.LESS_OR_EQUAL) + 1;
            lastBars = myBars.data.slice(ilast, myBars.length);
        }
        let resultBars;
        if (myBars instanceof CBarsInternal && myBars.Mutable)
            (resultBars = myBars).data.splice(ibar);
        else
            resultBars = new CBarsInternal(myBars.Tf, myBars.data.slice(0, ibar), myBars.tickSize);
        resultBars.data = resultBars.data.concat(newBars, lastBars);
        return resultBars;
    }
    _CreateUpdatedBars(myBars, updatedBars, startTime) {
        startTime = Bars_1.Period.StartTime(myBars.Tf, startTime);
        let addedBarsArr = updatedBars.getArray(startTime);
        let addedBarsArrConverted = new Bars_1.CBars(updatedBars.Tf, addedBarsArr ?? []).toBarsArray(myBars.Tf);
        return this._CombineBars(myBars, addedBarsArrConverted, startTime);
    }
    _getLessTf(tf) {
        let i = (0, common_1.BSearch)(this.barsInfoMap.sortedKeys, tf.index - 1, common_1.E_MATCH.LESS_OR_EQUAL);
        return (i >= 0) ? Bars_1.TF.all[this.barsInfoMap.sortedKeys[i]] : null;
    }
    _BuildNewBars(tf) {
        let lessTf = this._getLessTf(tf);
        if (lessTf == null)
            return null;
        let info = this.barsInfoMap[lessTf.index];
        let bars = info.modifyInfo ? this._Bars(info.modifyInfo.srcTf) : info.bars;
        let newbars = bars.toBarsArray(tf);
        if (!newbars) {
            console.log(`Failed to create bars ${tf.name} from ${bars.Tf.name}`);
            return null;
        }
        return new CBarsInternal(tf, newbars, this.tickSize);
    }
    _Bars(tf) { return this.barsInfoMap[typeof tf == "number" ? tf : tf.index].bars; }
    _GetBars(tf) {
        if (!tf)
            throw "undefined timeframe!";
        let Info = this.barsInfoMap[tf.index];
        let updated = false;
        let bars;
        if (Info) {
            if (Info.modifyInfo) {
                let srcTf = this._getLessTf(tf);
                if (!srcTf)
                    return null;
                bars = this._CreateUpdatedBars(Info.bars, this._GetBars(srcTf) ?? (() => { throw "null bars!"; })(), Info.modifyInfo.time);
                updated = true;
                Info.modifyInfo = undefined;
            }
            else
                bars = Info.bars;
        }
        else {
            bars = this._BuildNewBars(tf);
            if (!bars)
                return null;
            updated = true;
            Info = { bars: bars };
            this.barsInfoMap[tf.index] = Info;
        }
        if (updated) {
            for (let i = this.barsInfoMap.Values.length - 1; i >= 0; i--) {
                let info = this.barsInfoMap.Values[i];
                if (info.bars.Tf <= tf)
                    break;
                if (info.modifyInfo)
                    info.modifyInfo.srcTf = tf;
            }
        }
        if (bars != Info.bars) {
            Info.bars = bars;
            this.barsMainMap[tf.index] ??= bars;
        }
        return bars;
    }
    Bars(tf) {
        let bars = this._GetBars(tf);
        if (bars instanceof CBarsInternal)
            bars.Mutable = false;
        return bars;
    }
    get(tf) { return this.Bars(tf); }
}
exports.CQuotesHistory = CQuotesHistory;
class CQuotesHistoryMutable extends CQuotesHistory {
    _endTickTime;
    get isMutable() { return true; }
    constructor(name) {
        super([], name);
    }
    AddEndBars(bars, tf) { return this._AddBarsExt(bars, tf, true); }
    append(bars, tf) { return this._AddBarsExt(bars, tf, true); }
    AddStartBars(bars, tf) { return this._AddBarsExt(bars, tf, false); }
    prepend(bars, tf) { return this._AddBarsExt(bars, tf, false); }
    checkBars(bars, tf) {
        let period = new Bars_1.Period(tf);
        for (let i = 1; i < bars.length; i++)
            if (!bars[i]) {
                console.log("Отсутствует бар №" + i);
                return false;
            }
            else if (bars[i].time.valueOf() - bars[i - 1].time.valueOf() < tf.msec && period.span(bars[i].time).index <= period.span(bars[i - 1].time).index) {
                console.log("Некорректное время бара №" + i + ":", bars[i].time, "  Предыдущее время:", bars[i - 1].time);
                return false;
            }
        return true;
    }
    _AddBarsExt(Bars, tf, toEnd) {
        if (!Bars)
            return false;
        let bars = Bars instanceof Bars_1.IBars ? Bars.data : Bars instanceof Array ? Bars : [Bars];
        if (bars.length == 0)
            return true;
        if (Bars instanceof Bars_1.IBars)
            tf = Bars.Tf;
        else if (!this.checkBars(bars, tf))
            return false;
        if (!tf)
            return false;
        let oldBars0 = this._GetBars(tf);
        let oldBars = oldBars0 ?? new CBarsInternal(tf);
        let time = bars[0].time;
        let endtime = bars[bars.length - 1].time;
        if (oldBars.count > 0)
            if (!toEnd) {
                if (oldBars.time(0) < time)
                    time = oldBars.time(0);
            }
            else {
                if (oldBars.lastTime > endtime)
                    endtime = oldBars.lastTime;
            }
        let resultBars = this._CombineBars(oldBars, bars, time, endtime);
        if (!resultBars)
            return false;
        if (resultBars != oldBars0) {
            this.barsInfoMap[tf.index] = { bars: resultBars };
        }
        this.barsMainMap[tf.index] = resultBars;
        this._OnModify(tf, time, endtime, toEnd);
        if (!this._endTickTime || toEnd || bars[bars.length - 1].time >= Bars_1.Period.StartTime(tf, this._endTickTime))
            this._endTickTime = new Date(resultBars.lastTime.valueOf() + 1);
        return true;
    }
    AddTicks(ticks) {
        if (!ticks || ticks.length == 0)
            return true;
        let time = ticks[0].time;
        let tf = Bars_1.TF.S1;
        let oldBars = this._GetBars(tf);
        let newbarsArr;
        if (oldBars && oldBars.count > 0 && Bars_1.Period.StartTime(tf, time).valueOf() == oldBars.lastTime.valueOf())
            newbarsArr = [oldBars.last];
        let newbars = new Bars_1.CBarsMutable(tf, newbarsArr);
        if (!newbars.AddTicks(ticks))
            return false;
        this._endTickTime = ticks[ticks.length - 1].time;
        return this.AddEndBars(newbars);
    }
    AddTick(tick) { return this.AddTicks([tick]); }
    addTicks(ticks) { return this.AddTicks(ticks); }
    getOrSetMutableBars(tf) {
        let bars = this._GetBars(tf) ?? new CBarsInternal(tf);
        let mutableBars;
        if (!(bars instanceof CBarsInternal) || !bars.Mutable) {
            mutableBars = new CBarsInternal(bars.Tf, bars.data, bars.tickSize);
            this.barsMainMap[tf.index] = mutableBars;
            this.barsInfoMap[tf.index].bars = mutableBars;
        }
        else
            mutableBars = bars;
        return mutableBars;
    }
    AddNewTicks(ticks) {
        if (ticks.length == 0)
            return;
        if (this._endTickTime && ticks[0].time < this._endTickTime)
            throw "Время тика меньше предыдущего!";
        let tfIndexes = this.barsInfoMap.sortedKeys;
        if (tfIndexes[0] > Bars_1.TF.S1.index)
            tfIndexes = [Bars_1.TF.S1.index, ...tfIndexes];
        for (let tfVal of tfIndexes) {
            let tf = Bars_1.TF.all[tfVal];
            let mutableBars = this.getOrSetMutableBars(tf);
            mutableBars.AddTicks(ticks);
        }
        this._modifyCounter++;
        this._endTickTime = ticks[ticks.length - 1].time;
    }
    AddNewTick(tick) { return this.AddNewTicks([tick]); }
    deleteBefore(time) {
        time = new Date(time.valueOf() - 1);
        for (let { bars } of this.barsInfoMap.Values) {
            if (bars.firstTime <= time && time <= bars.lastCloseTime) {
                let mutableBars = this.getOrSetMutableBars(bars.Tf);
                let i = bars.indexOf(time, "greatOrEqual");
                console.assert(i != -1, "i==-1 for time " + time.toString());
                mutableBars.data.splice(0, i + 1);
            }
        }
        this._modifyCounter++;
    }
}
exports.CQuotesHistoryMutable = CQuotesHistoryMutable;
;
class CQuotesHistoryMutable2 extends CQuotesHistory {
    _source;
    _time;
    _sourceCounter = 0;
    get tickSize() { return this._source?.tickSize ?? 0; }
    get minTf() { return this._source?.minTf ?? null; }
    get isMutable() { return true; }
    constructor(name) {
        super([], name);
    }
    _CreateNewBars(tf) {
        let srcBars = this._source?.Bars(tf);
        if (!srcBars)
            return null;
        let istop = this._time ? srcBars.indexOf(this._time, common_1.E_MATCH.GREAT_OR_EQUAL) : srcBars.length;
        let slicedBars = srcBars.data.slice(0, istop);
        return new CBarsInternal(tf, slicedBars);
    }
    Update(other, endTime) {
        let isUpdate = other == this._source && other.stateID == this._sourceCounter;
        for (let info of this.barsInfoMap.Values) {
            let bars = info.bars;
            let srcBars = other.Bars(bars.Tf);
            if (!srcBars)
                continue;
            let start = 0;
            if (isUpdate && (endTime && this._time ? endTime >= this._time : endTime == this._time))
                start = bars.data.length;
            let stop = endTime ? srcBars.indexOf(endTime, common_1.E_MATCH.GREAT_OR_EQUAL) : srcBars.length;
            let newbarsArr = srcBars.data.slice(start, stop);
            let resultbarsArr = start > 0 ? [...bars.data, ...newbarsArr] : newbarsArr;
            let resultBars = new Bars_1.CBars(bars.Tf, resultbarsArr, bars.tickSize);
            info.bars = resultBars;
            if (this.barsMainMap[bars.Tf.index])
                this.barsMainMap[bars.Tf.index] = resultBars;
        }
        this._source = other;
        this._sourceCounter = other.stateID;
        this._time = endTime;
        this._modifyCounter++;
    }
}
exports.CQuotesHistoryMutable2 = CQuotesHistoryMutable2;
