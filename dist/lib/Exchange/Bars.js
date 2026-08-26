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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CTimeSeries = exports.CTimeSeriesBase = exports.createRandomBars = exports.CBarsMutableExt = exports.CBarsMutable = exports.CBarsMutableBase = exports.CBars = exports.CBarsBase = exports.IBars = exports.CTick = exports.CBar = exports.CBarBase = exports.OHLC = void 0;
exports.CreateRandomBars = CreateRandomBars;
exports.findBarsShallow = findBarsShallow;
const lib = __importStar(require("../Common/core/common"));
const common_1 = require("../Common/core/common");
const Time_1 = require("../Common/Time");
__exportStar(require("../Common/Time"), exports);
class OHLC {
    open;
    high;
    low;
    close;
    constructor(open, high, low, close) { return Object.assign(this, { open, high, low, close }); }
}
exports.OHLC = OHLC;
class CBarBase {
    time;
    open;
    high;
    low;
    close;
    volume;
    tickVolume;
    constructor(timeOrBar, open = 0, high = 0, low = 0, close = 0, volume = 0, tickVolume = 0) {
        function isDate(obj) { return obj instanceof Date; }
        if (isDate(timeOrBar)) {
            this.time = timeOrBar;
            this.open = open;
            this.high = high;
            this.low = low;
            this.close = close;
            this.volume = volume;
            this.tickVolume = tickVolume;
        }
        else {
            let b = timeOrBar;
            this.time = b.time;
            this.open = b.open;
            this.high = b.high;
            this.low = b.low;
            this.close = b.close;
            this.volume = b.volume;
            this.tickVolume = b.tickVolume;
        }
    }
}
exports.CBarBase = CBarBase;
class CBar extends CBarBase {
    static new(time, ohlc, volume = 0, tickVolume = 0) {
        return new CBar(time, ohlc.open, ohlc.high, ohlc.low, ohlc.close, volume, tickVolume);
    }
    static fromParsedJSON(data) { return new CBar(new Date(data.time), data.open, data.high, data.low, data.close, data.volume, data.tickVolume ?? 0); }
}
exports.CBar = CBar;
class CTick {
    time;
    price;
    volume;
    constructor(time, price, volume) { this.time = time; this.price = price; this.volume = volume; }
    ;
}
exports.CTick = CTick;
function getDraftTickSize(bars) { return bars instanceof CBarsBase ? bars._tickSize : bars.tickSize; }
class IBars {
    [Symbol.iterator]() { return this.data[Symbol.iterator](); }
    Tf;
    constructor(tf) {
        this.Tf = tf;
        console.assert(tf.msec <= Time_1.TF.W1.msec);
        return lib.CreateArrayProxy(this, (i) => this.data[i]);
    }
    get Immutable() { return !this.Mutable; }
    toImmutable() { return this.Mutable ? new CBars(this.Tf, this.data, getDraftTickSize(this)) : this; }
    get count() { return this.data?.length ?? 0; }
    get length() { return this.count; }
    get last() { return this.count > 0 ? this.data[this.count - 1] : undefined; }
    backwardBar(i) { return this.data[this.length - 1 - i]; }
    _getBar(i, prop) { return this.data[i] ?? (() => { console.trace(); throw ("Wrong bar index: i=" + i + ", barsTotal=" + this.count + ", property: " + prop); })(); }
    at(i) { return this.data.at(i); }
    time(i) { return this._getBar(i, "time").time; }
    open(i) { return this._getBar(i, "open").open; }
    high(i) { return this._getBar(i, "high").high; }
    low(i) { return this._getBar(i, "low").low; }
    close(i) { return this._getBar(i, "close").close; }
    volume(i) { return this._getBar(i, "volume").volume; }
    tickVolume(i) { return this._getBar(i, "tickVolume").tickVolume; }
    closeTime(i) { return Time_1.Period.EndTime(this.Tf, this.time(i)); }
    get firstTime() { return this.count > 0 ? this.data[0].time : null; }
    get lastTime() { return this.count > 0 ? this.data[this.count - 1].time : null; }
    get lastCloseTime() { return this.count > 0 ? this.closeTime(this.count - 1) : null; }
    Values(getter) { return new common_1.VirtualItems((i) => getter(this.data[i]), () => this.data.length); }
    get times() { return this.Values((bar) => bar.time); }
    get opens() { return this.Values((bar) => bar.open); }
    get highs() { return this.Values((bar) => bar.high); }
    get lows() { return this.Values((bar) => bar.low); }
    get closes() { return this.Values((bar) => bar.close); }
    get volumes() { return this.Values((bar) => bar.volume); }
    entries() { return this.data.entries(); }
    indexOf(time, match) {
        time = Time_1.Period.StartTime(this.Tf, time);
        return lib.BSearch(this.data, time, (bar, time) => bar.time.valueOf() - time.valueOf(), match ? match : common_1.BSearch.EQUAL);
    }
    indexOfLessOrEqual(time) { return this.indexOf(time, "lessOrEqual"); }
    concat(newBars) {
        let bars = newBars instanceof Array ? newBars : [newBars];
        let time = bars && bars.length > 0 && this.count > 0 ? bars[0].time : null;
        if (time && time <= this.lastTime) {
            console.error("Wrong bar start time:  " + time.toString() + " <= " + this.lastTime.toString());
            return null;
        }
        return new CBars(this.Tf, this.data.concat(bars), this.tickSize);
    }
    slice(startIndex, stopIndex) { let result = this.data.slice(startIndex, stopIndex); return new CBars(this.Tf, result, this.tickSize); }
    sliceMutable(startIndex, stopIndex) { let result = this.data.slice(startIndex, stopIndex); return new CBarsMutable(this.Tf, result, this.tickSize); }
    sliceByTime(startTime, lastTime) {
        let arr = this.getArray(startTime, lastTime);
        return new CBars(this.Tf, arr ?? [], this.tickSize);
    }
    *range(timeStart, timeEnd) {
        if (this.length == 0)
            return;
        let ibar = timeStart ? this.indexOf(timeStart, "greatOrEqual") : 0;
        timeEnd ??= this.lastTime;
        for (let i = ibar; i < this.length && this.data[i].time <= timeEnd; i++)
            yield this.data[i];
    }
    getArray(startTime, lastTime) {
        let istart = startTime ? this.indexOf(startTime, common_1.BSearch.GREAT_OR_EQUAL) : 0;
        let ilast = lastTime ? this.indexOf(lastTime, common_1.BSearch.LESS_OR_EQUAL) : this.data.length - 1;
        if (istart == -1 || istart > ilast)
            return null;
        return this.data.slice(istart, ilast + 1);
    }
    toBars(tf, endDayTime_s) {
        let bars = this.toBarsArray(tf, endDayTime_s);
        return new CBarsMutable(tf, bars, this instanceof CBarsBase ? this._tickSize : this.tickSize);
    }
    toBarsImmutable(tf, endDayTime_s) {
        if (tf == this.Tf && endDayTime_s == null)
            return this.toImmutable();
        return Object.assign(this.toBars(tf, endDayTime_s), { Mutable: false });
    }
    toBarsArray(dstTf, endDayTime_s) {
        const src = this;
        if (src.Tf == dstTf && !endDayTime_s) {
            return [...src.data];
        }
        console.assert(dstTf.sec > 0);
        let count = src.count;
        let dst = new Array(count);
        let mainTime = count > 0 ? src.time(0) : new Date(0);
        let period = new Time_1.Period(dstTf);
        let nextPeriodTime = period.span(mainTime).next().startTime;
        let istart = 0;
        let ilast = 0;
        let n = 0;
        for (let i = 1; i <= count; i++) {
            let bartime = i < count ? src.time(i) : new Date(2100, 0, 1);
            if (endDayTime_s && bartime.valueOf() % Time_1.D1_MS >= endDayTime_s * 1000 % Time_1.D1_MS)
                continue;
            if (bartime >= nextPeriodTime) {
                let close = src.close(ilast);
                let time = period.span(mainTime).startTime;
                let high = src._getHighestHigh(istart, ilast);
                let low = src._getLowestLow(istart, ilast);
                let open = src.open(istart);
                let volume = src.getSumVolume(istart, ilast);
                let tickVolume = src.getSumTickVolume(istart, ilast);
                dst[n] = new CBar(time, open, high, low, close, volume, tickVolume);
                mainTime = bartime;
                istart = i;
                n++;
                nextPeriodTime = period.span(mainTime).next().startTime;
            }
            ilast = i;
        }
        dst.length = n;
        return dst;
    }
    _getHighestHigh(i0, i1) { let a = -Number.MAX_VALUE; for (let i = i0; i <= i1; i++)
        a = Math.max(a, this.high(i)); return a; }
    _getLowestLow(i0, i1) { let a = Number.MAX_VALUE; for (let i = i0; i <= i1; i++)
        a = Math.min(a, this.low(i)); return a; }
    getBest(comparer, iFirst, iLast) {
        iFirst ??= 0;
        iLast ??= this.count - 1;
        if (iFirst > iLast)
            return [undefined, undefined];
        let n = iFirst, bestBar = this.data[iFirst];
        for (let i = iFirst + 1; i <= iLast; i++) {
            let bar = this.data[i];
            if (comparer(bestBar, bar) == true)
                [n, bestBar] = [i, bar];
        }
        return [n, bestBar];
    }
    getFirstHighest(iFirst, iLast) { return this.getBest((old, current) => current.high > old.high, iFirst, iLast); }
    getFirstLowest(iFirst, iLast) { return this.getBest((old, current) => current.low < old.low, iFirst, iLast); }
    getSumVolume(i0, i1) { let sum = 0; for (let i = i0; i <= i1; i++)
        sum += this.volume(i); return sum; }
    getSumTickVolume(i0, i1) { let sum = 0; for (let i = i0; i <= i1; i++)
        sum += this.tickVolume(i); return sum; }
}
exports.IBars = IBars;
class CBarsBase extends IBars {
    _data;
    _ticksize;
    get _tickSize() { return this._ticksize; }
    get data() { return this._data; }
    get tickSize() { return this._ticksize ||= lib.MaxCommonDivisorOnArray(this.closes); }
    _Add(bars) { this._data = this._data.concat(bars); }
    constructor(tf, bars, tickSize) {
        super(tf);
        this._ticksize = tickSize ? tickSize : 0;
        if (bars == null)
            bars = [];
        if (bars instanceof IBars) {
            if (tf != bars.Tf)
                this._data = bars.toBarsArray(tf) ?? [];
            else
                this._data = !bars.Mutable ? bars.data : [...bars];
        }
        else
            this._data = [...bars];
    }
    static fromParsedJSON(data) {
        let d = data;
        let tf = Time_1.TF.fromSec(d.Tf.sec);
        if (!tf) {
            console.assert(tf != null);
            throw ("wrong TF");
        }
        let obj = new CBars(tf, d._data.map((el) => CBar.fromParsedJSON(el)));
        return obj;
    }
}
exports.CBarsBase = CBarsBase;
class CBars extends CBarsBase {
    constructor(tf, bars, tickSize) { super(tf, bars ?? [], tickSize); }
    Mutable = false;
    static createCopy(bars) { return new CBars(bars.Tf, bars.data, bars.tickSize); }
    static createCopyExt(bars, lastBarClosed) {
        let obj = Object.assign(CBars.createCopy(bars), {
            lastBarClosed,
            barInfo: (i) => CBars.createBarInfo(obj, i)
        });
        return obj;
    }
    static createBarInfo(bars, i) {
        return {
            bar: bars.data[i] ?? (() => { console.trace(); throw ("Wrong bar index: i=" + i + " barsTotal=" + bars.count); })(),
            index: i,
            closed: bars.lastBarClosed || i < bars.count - 1,
            getAllBars: () => bars
        };
    }
}
exports.CBars = CBars;
let x = [];
for (let fff of x) { }
class CBarsMutableBase extends CBarsBase {
    _tickSizeAuto;
    get data() { return this._data; }
    constructor(tf, bars, tickSize) { super(tf, bars ?? [], tickSize); this._tickSizeAuto = !tickSize; }
    Add(Bars) {
        let bars = Bars instanceof Array ? Bars : [Bars];
        if (!bars || bars.length == 0)
            return;
        let time = bars[0].time;
        if (this.count > 0 && time <= this.lastTime)
            throw "Wrong bar time:  " + time + " <= " + this.lastTime;
        if (!this.data)
            this._data = [];
        for (let bar of bars)
            Object.freeze(bar);
        this.data.push(...bars);
        if (this._tickSizeAuto)
            this._ticksize = 0;
    }
    push(bars) { this.Add(bars); }
    updateLast(bar) {
        if (this.lastTime)
            if (bar.time.valueOf() == this.lastTime.valueOf()) {
                this.data[this.length - 1] = { ...bar };
                if (this._tickSizeAuto)
                    this._ticksize = 0;
                return;
            }
            else if (bar.time < this.lastTime)
                throw "Wrong bar time:  " + bar.time + " < " + this.lastTime;
        this.push(bar);
    }
    AddTick(tick) {
        if (!tick)
            return false;
        if (this.count > 0 && tick.time < this.lastTime) {
            console.error("Wrong tick time:  " + tick.time + " < " + this.lastTime);
            return false;
        }
        let barTime = Time_1.Period.StartTime(this.Tf, tick.time);
        let bar;
        let price = tick.price;
        let i = this.count;
        if (this.count > 0 && barTime.valueOf() == this.lastTime.valueOf()) {
            bar = this.last;
            i--;
            bar = new CBar(barTime, bar.open, Math.max(bar.high, price), Math.min(bar.low, price), price, bar.volume + tick.volume, bar.tickVolume + 1);
        }
        else
            bar = new CBar(barTime, price, price, price, price, tick.volume, 1);
        if (!this._data)
            this._data = [];
        Object.freeze(bar);
        this.data[i] = bar;
        if (this._tickSizeAuto)
            this._ticksize = 0;
        return true;
    }
    AddTicks(ticks) { for (let tick of ticks)
        if (!this.AddTick(tick))
            return false; return true; }
    addTick(tick) { return this.AddTick(tick); }
    addTicks(ticks) { return this.AddTicks(ticks); }
}
exports.CBarsMutableBase = CBarsMutableBase;
class CBarsMutable extends CBarsMutableBase {
    Mutable = true;
}
exports.CBarsMutable = CBarsMutable;
class CBarsMutableExt extends CBarsMutable {
    lastBarClosed = true;
    barInfo = (i) => CBars.createBarInfo(this, i);
}
exports.CBarsMutableExt = CBarsMutableExt;
function CreateRandomBars(tf, startTime, endTimeOrCount, startPrice = 100, volatility = "1%", tickSize) {
    if (!tf || tf.msec == 0)
        return null;
    console.log("Creating bars with parameters: ", ...([...arguments].map(arg => arg instanceof Time_1.TF ? arg.name : arg)));
    const tickSizeNum = tickSize ?? 10 ** Math.min(Math.round(Math.log10(startPrice > 0 ? startPrice : 1) - 4), 0);
    let period = new Time_1.Period(tf);
    let count;
    if (typeof endTimeOrCount == "number")
        count = endTimeOrCount;
    else
        count = period.IndexFromTime(endTimeOrCount) - period.IndexFromTime(startTime) + 1;
    console.log(count);
    if (count < 0)
        return null;
    let bars = new Array(count);
    let price = startPrice;
    let periodSpan = period.span(startTime);
    let digits = (0, common_1.GetDblPrecision)(tickSizeNum);
    function norm(value) { return (0, common_1.NormalizeDouble)(Math.round(value / tickSizeNum) * tickSizeNum, digits); }
    const [volatFactor, volatNum] = typeof volatility == "string" ? [Number(volatility.slice(0, -1)) / 100, undefined] : [undefined, volatility];
    for (let i = 0; i < count; i++) {
        const volat = volatNum ?? volatFactor * price;
        let open = norm(price + (Math.random() * 2 - 1) * volat / 10);
        let high = norm(open + Math.random() * volat);
        let low = norm(open - Math.random() * volat);
        let close = norm(low + Math.random() * (high - low));
        let volume = tf.msec;
        let time = periodSpan.startTime;
        let bar = new CBar(time, open, high, low, close, volume, volume);
        bars[i] = bar;
        periodSpan = periodSpan.next();
        price = close;
    }
    return new CBars(tf, bars);
}
exports.createRandomBars = CreateRandomBars;
class CTimeSeriesBase {
    time(i) { return this.points[i]?.time ?? (() => { throw "Wrong index i=" + i + " of " + this.length; })(); }
    value(i) { return this.points[i]?.value ?? (() => { throw "Wrong index i=" + i + " of " + this.length; })(); }
    get last() { return this.points.at(-1); }
    get times() { return new lib.VirtualItems((i) => this.time(i), () => this.length); }
    get values() { return new lib.VirtualItems((i) => this.value(i), () => this.length); }
    get length() { return this.points.length; }
    indexOf(time, match) { return (0, common_1.BSearch)(this.times, time, match); }
    constructor() {
        return (0, common_1.CreateArrayProxy)(this, (i) => this.points[i]);
    }
    [Symbol.iterator]() { return this.points[Symbol.iterator](); }
}
exports.CTimeSeriesBase = CTimeSeriesBase;
class CTimeSeries extends CTimeSeriesBase {
    points = [];
    name;
    constructor(name, points) {
        super();
        this.name = name;
        this.points = points ? [...points] : [];
    }
    static fromParsedJSON(data) {
        if (!data)
            return data;
        let obj = new CTimeSeries();
        console.assert(data.points != null);
        obj.name = data.name;
        obj.points = data.points.map((pnt) => { return { time: new Date(pnt.time), value: pnt.value }; });
        return obj;
    }
    write(stream, arg) {
        let valueWriter = (typeof arg == "function") ? arg : (stream, value) => stream.pushNumber(value, arg);
        function _writePoint(stream, pair) { return stream.pushInt64(pair.time.valueOf()) != null && valueWriter(stream, pair.value) != false; }
        return stream.pushUnicode(this.name ?? null).pushArrayByFunc(this.points, _writePoint) != null;
    }
    static read(stream, arg) {
        let valueGetter = (typeof arg == "function") ? arg : (stream) => stream.readNumber(arg);
        let name = stream.readUnicode();
        let points = stream.readArray((stream) => ({ time: new Date(stream.readUint64()), value: valueGetter(stream) }));
        return new CTimeSeries(name ?? undefined, points);
    }
}
exports.CTimeSeries = CTimeSeries;
function _findBars(srcBars, barsToFind, mode) {
    let len = barsToFind.length;
    if (srcBars.length < len || len == -1)
        return -1;
    let start = 0;
    let end = len - 1;
    let iStart = (0, common_1.BSearch)(srcBars, barsToFind[start].time, (bar, time) => bar.time.valueOf() - time.valueOf());
    let iEnd = (0, common_1.BSearch)(srcBars, barsToFind[end].time, (bar, time) => bar.time.valueOf() - time.valueOf());
    if (iStart < 0 || iEnd < 0 || iEnd - iStart + 1 != len)
        return -1;
    let delta = start - iStart;
    if (mode == "deep") {
        for (let i = iStart; i <= iEnd; i++)
            if (!(0, common_1.deepEqual)(srcBars[i], barsToFind[i + delta]))
                return -1;
    }
    else
        for (let i = iStart; i <= iEnd; i++)
            if (srcBars[i] != barsToFind[i + delta])
                return -1;
    return iStart;
}
function findBarsDeep(srcBars, barsToFind) {
    return _findBars(srcBars, barsToFind, "deep");
}
function findBarsShallow(srcBars, barsToFind) {
    return _findBars(srcBars, barsToFind, "shallow");
}
