"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maxDate = exports.minDate = exports.CDelayer = exports.Period = exports.PeriodSpan = exports.TF = exports.TIME_UNIT = exports.M1_MS = exports.H1_MS = exports.D1_MS = exports.W1_MS = exports.W1_S = exports.D1_S = exports.H1_S = void 0;
exports.timeToStr_hhmmss_ms = timeToStr_hhmmss_ms;
exports.timeToStr_hhmmss = timeToStr_hhmmss;
exports.timeToStr_yyyymmdd_hhmm = timeToStr_yyyymmdd_hhmm;
exports.timeToStr_yyyymmdd_hhmmss = timeToStr_yyyymmdd_hhmmss;
exports.timeToStr_yyyymmdd_hhmmss_ms = timeToStr_yyyymmdd_hhmmss_ms;
exports.timeLocalToStr_hhmmss = timeLocalToStr_hhmmss;
exports.timeLocalToStr_hhmmss_ms = timeLocalToStr_hhmmss_ms;
exports.timeLocalToStr_yyyymmdd = timeLocalToStr_yyyymmdd;
exports.timeLocalToStr_yyyymmdd_hhmm = timeLocalToStr_yyyymmdd_hhmm;
exports.timeLocalToStr_yyyymmdd_hhmmss = timeLocalToStr_yyyymmdd_hhmmss;
exports.timeLocalToStr_yyyymmdd_hhmmss_ms = timeLocalToStr_yyyymmdd_hhmmss_ms;
exports.timeToString_yyyymmdd_hhmm_offset = timeToString_yyyymmdd_hhmm_offset;
exports.timeToString_yyyymmdd_hhmmss_offset = timeToString_yyyymmdd_hhmmss_offset;
exports.format = format;
exports.convertDatesToStrings = convertDatesToStrings;
exports.toPrintObject = toPrintObject;
exports.durationToStr = durationToStr;
exports.durationToStrNullable = durationToStrNullable;
exports.durationToStr_h_mm_ss = durationToStr_h_mm_ss;
exports.durationToStr_h_mm_ss_ms = durationToStr_h_mm_ss_ms;
exports.formatDuration = formatDuration;
exports.MinTime = MinTime;
exports.MaxTime = MaxTime;
const common_1 = require("./core/common");
function GetEnumKeys(T) { return Object.keys(T).filter(k => isNaN(k)); }
{
    let t1 = "2022-05-01";
    let t2 = "2022-05-01 01:01";
    let t3 = "2022-05-01 01:01:10";
}
exports.H1_S = 3600;
exports.D1_S = 3600 * 24;
exports.W1_S = exports.D1_S * 7;
exports.W1_MS = exports.W1_S * 1000;
exports.D1_MS = exports.D1_S * 1000;
exports.H1_MS = exports.H1_S * 1000;
exports.M1_MS = 60 * 1000;
var __E_TF;
(function (__E_TF) {
    __E_TF[__E_TF["S1"] = 1] = "S1";
    __E_TF[__E_TF["S2"] = 2] = "S2";
    __E_TF[__E_TF["S3"] = 3] = "S3";
    __E_TF[__E_TF["S4"] = 4] = "S4";
    __E_TF[__E_TF["S5"] = 5] = "S5";
    __E_TF[__E_TF["S6"] = 6] = "S6";
    __E_TF[__E_TF["S10"] = 7] = "S10";
    __E_TF[__E_TF["S12"] = 8] = "S12";
    __E_TF[__E_TF["S15"] = 9] = "S15";
    __E_TF[__E_TF["S20"] = 10] = "S20";
    __E_TF[__E_TF["S30"] = 11] = "S30";
    __E_TF[__E_TF["M1"] = 12] = "M1";
    __E_TF[__E_TF["M2"] = 13] = "M2";
    __E_TF[__E_TF["M3"] = 14] = "M3";
    __E_TF[__E_TF["M4"] = 15] = "M4";
    __E_TF[__E_TF["M5"] = 16] = "M5";
    __E_TF[__E_TF["M6"] = 17] = "M6";
    __E_TF[__E_TF["M10"] = 18] = "M10";
    __E_TF[__E_TF["M12"] = 19] = "M12";
    __E_TF[__E_TF["M15"] = 20] = "M15";
    __E_TF[__E_TF["M20"] = 21] = "M20";
    __E_TF[__E_TF["M30"] = 22] = "M30";
    __E_TF[__E_TF["H1"] = 23] = "H1";
    __E_TF[__E_TF["H2"] = 24] = "H2";
    __E_TF[__E_TF["H3"] = 25] = "H3";
    __E_TF[__E_TF["H4"] = 26] = "H4";
    __E_TF[__E_TF["H6"] = 27] = "H6";
    __E_TF[__E_TF["H8"] = 28] = "H8";
    __E_TF[__E_TF["H12"] = 29] = "H12";
    __E_TF[__E_TF["D1"] = 30] = "D1";
    __E_TF[__E_TF["W1"] = 31] = "W1";
    __E_TF[__E_TF["MN1"] = 32] = "MN1";
    __E_TF[__E_TF["MN2"] = 33] = "MN2";
    __E_TF[__E_TF["MN3"] = 34] = "MN3";
    __E_TF[__E_TF["MN4"] = 35] = "MN4";
    __E_TF[__E_TF["MN6"] = 36] = "MN6";
    __E_TF[__E_TF["Y1"] = 37] = "Y1";
})(__E_TF || (__E_TF = {}));
;
const __Tf_S = [0, 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 300, 360, 600, 720, 900, 1200, 1800, exports.H1_S, 2 * exports.H1_S, 3 * exports.H1_S, 4 * exports.H1_S, 6 * exports.H1_S, 8 * exports.H1_S, 12 * exports.H1_S, exports.D1_S, exports.W1_S, 30 * exports.D1_S, 60 * exports.D1_S, 90 * exports.D1_S, 120 * exports.D1_S, 180 * exports.D1_S, 365 * exports.D1_S];
class TIME_UNIT {
    index;
    msec;
    sec;
    name;
    sign;
    static _lastIndex = 0;
    constructor(msec, name, shortName) {
        this.index = ++TIME_UNIT._lastIndex;
        this.msec = msec;
        this.sec = Math.floor(msec / 1000);
        this.name = name;
        this.sign = shortName;
    }
    static MSecond = new TIME_UNIT(1, "millisecond", "MS");
    static Second = new TIME_UNIT(1000, "second", "S");
    static Minute = new TIME_UNIT(60 * 1000, "minute", "M");
    static Hour = new TIME_UNIT(exports.H1_S * 1000, "hour", "H");
    static Day = new TIME_UNIT(exports.D1_S * 1000, "day", "D");
    static Week = new TIME_UNIT(7 * exports.D1_S * 1000, "week", "W");
    static Month = new TIME_UNIT(30 * exports.D1_S * 1000, "month", "MN");
    static Year = new TIME_UNIT(365 * exports.D1_S * 1000, "year", "Y");
}
exports.TIME_UNIT = TIME_UNIT;
class TF {
    sec;
    msec;
    name;
    unit;
    unitCount;
    index;
    valueOf() { return this.msec; }
    toString() { return this.name; }
    constructor(unit, unitCount, index, msec, name) {
        this.unit = unit;
        this.unitCount = unitCount;
        this.msec = msec ?? unit.msec * unitCount;
        this.sec = Math.floor(this.msec / 1000);
        this.index = index;
        this.name = name ?? (unit.sign + unitCount);
    }
    static constructFromSec(sec, name) {
        let msec = sec * 1000;
        let index = __Tf_S.indexOf(sec);
        let units = [TIME_UNIT.Year, TIME_UNIT.Month, TIME_UNIT.Week, TIME_UNIT.Day, TIME_UNIT.Hour, TIME_UNIT.Minute, TIME_UNIT.Second, TIME_UNIT.MSecond];
        let unit = units.find((u) => Math.floor(sec % u.sec) == 0);
        let unitCount = Math.floor(sec / unit.sec);
        return new TF(unit, unitCount, index, msec, name);
    }
    static get(name) {
        let key = __E_TF[name];
        if (key)
            return this.all[key];
        return null;
    }
    static getAsserted(name) { return TF.get(name) ?? (() => { throw "Unknown timeframe: " + name; })(); }
    static fromName(name) { return this.get(name); }
    static fromSec(value) { return this._mapBySec[value]; }
    static createCustomFromSec(sec) { return TF.constructFromSec(sec); }
    static createCustom(unit, unitCount) { return new TF(unit, unitCount, -1); }
    static all = function () {
        let i = 1;
        let arr = [];
        for (let key of GetEnumKeys(__E_TF)) {
            arr[__E_TF[key]] = TF.constructFromSec(__Tf_S[i], key);
            i++;
        }
        return arr;
    }();
    static _mapBySec = function () {
        let map = {};
        for (let i of __Tf_S.keys())
            map[__Tf_S[i]] = TF.all[i];
        return map;
    }();
    static S1 = TF.get("S1");
    static S2 = TF.get("S2");
    static S3 = TF.get("S3");
    static S4 = TF.get("S4");
    static S5 = TF.get("S5");
    static S6 = TF.get("S6");
    static S10 = TF.get("S10");
    static S12 = TF.get("S12");
    static S15 = TF.get("S15");
    static S20 = TF.get("S20");
    static S30 = TF.get("S30");
    static M1 = TF.get("M1");
    static M2 = TF.get("M2");
    static M3 = TF.get("M3");
    static M4 = TF.get("M4");
    static M5 = TF.get("M5");
    static M6 = TF.get("M6");
    static M10 = TF.get("M10");
    static M12 = TF.get("M12");
    static M15 = TF.get("M15");
    static M20 = TF.get("M20");
    static M30 = TF.get("M30");
    static H1 = TF.get("H1");
    static H2 = TF.get("H2");
    static H3 = TF.get("H3");
    static H4 = TF.get("H4");
    static H6 = TF.get("H6");
    static H8 = TF.get("H8");
    static H12 = TF.get("H12");
    static D1 = TF.get("D1");
    static W1 = TF.get("W1");
    static MN1 = TF.get("MN1");
    static MN2 = TF.get("MN2");
    static MN3 = TF.get("MN3");
    static MN4 = TF.get("MN4");
    static MN6 = TF.get("MN6");
    static Y1 = TF.get("Y1");
    static min(...args) {
        let tfs = ((args[0] && !(args[0] instanceof TF)) ? args[0] : args);
        let index = 999;
        for (let tf of tfs)
            if (tf)
                index = Math.min(tf.index, index);
        return index != 999 ? this.all[index] : null;
    }
    static max(...args) {
        let tfs = ((args[0] && !(args[0] instanceof TF)) ? args[0] : args);
        let index = -1;
        for (let tf of tfs)
            if (tf)
                index = Math.max(tf.index, index);
        return index != -1 ? this.all[index] : null;
    }
}
exports.TF = TF;
function TimeAddMilliseconds(time, shift) { return new Date(time.valueOf() + shift); }
class MyDate extends Date {
    ToShiftedMsTime(shiftMs) { return TimeAddMilliseconds(this, shiftMs); }
}
class PeriodSpan {
    period;
    index;
    constructor(period, indexOrTime) {
        this.period = period instanceof Period ? period : new Period(period);
        this.index = indexOrTime instanceof Date ? this.period.IndexFromTime(indexOrTime) : indexOrTime;
    }
    next() { return new PeriodSpan(this.period, this.index + 1); }
    prev() { return new PeriodSpan(this.period, this.index - 1); }
    get startTime() { return Period.StartTimeForIndex(this.period.tf, this.index); }
    get endTime() { return Period.StartTimeForIndex(this.period.tf, this.index + 1).ToShiftedMsTime(-1); }
}
exports.PeriodSpan = PeriodSpan;
class Period {
    tf;
    get sec() { return this.tf.sec; }
    get msec() { return this.tf.msec; }
    get name() { return this.tf.name; }
    valueOf() { return this.msec; }
    span(time) { return new PeriodSpan(this.tf, time); }
    constructor(tf) { this.tf = tf; return (0, common_1.CreateArrayProxy)(this, (i) => new PeriodSpan(tf, i)); }
    static Seconds(tf) { return tf.sec; }
    static Name(tf) { return tf.name; }
    IndexFromTime(time) {
        return Period.IndexFromTime(this.tf, time);
    }
    getStartTime(currentTime) { return Period.StartTime(this.tf, currentTime); }
    static getW1Shift_ms() {
        const day0 = new Date(0).getUTCDay();
        const tshift = exports.D1_MS * Math.trunc((day0 + 6) % 7);
        return tshift;
    }
    static W1Shift_ms = this.getW1Shift_ms();
    static year0 = new Date(0).getUTCFullYear();
    static IndexFromTime(tf, time) {
        const tf_msec = tf.msec;
        if (tf.unit == TIME_UNIT.Week) {
            return Math.floor((time.valueOf() + Period.W1Shift_ms) / tf_msec);
        }
        if (tf.unit == TIME_UNIT.Month) {
            return Math.floor(((time.getFullYear() - Period.year0) * 12 + time.getMonth()) / tf.unitCount);
        }
        if (tf.unit == TIME_UNIT.Year) {
            return time.getFullYear() - Period.year0;
        }
        return Math.floor(time.valueOf() / tf_msec);
    }
    static StartTimeForIndex(tf, index) {
        const tf_msec = tf.msec;
        if (tf.unit == TIME_UNIT.Week) {
            return new MyDate(index * tf_msec - this.getW1Shift_ms());
        }
        if (tf.unit == TIME_UNIT.Month) {
            return new MyDate(Period.year0 + Math.floor(index * tf.unitCount / 12), Math.floor(index * tf.unitCount % 12), 1);
        }
        if (tf.unit == TIME_UNIT.Year)
            return new MyDate(Period.year0 + index, 0, 1);
        return new MyDate(index * tf_msec);
    }
    static StartTime(tf, currentTime, shiftPeriods = 0) {
        let index = this.IndexFromTime(tf, currentTime) + shiftPeriods;
        return this.StartTimeForIndex(tf, index);
    }
    static EndTime(tf, currentTime) { return this.StartTime(tf, currentTime, +1).ToShiftedMsTime(-1); }
}
exports.Period = Period;
function str2(n) { return n <= 9 ? '0' + n : '' + n; }
function str3(n) { return (n <= 9 ? '00' : n <= 99 ? '0' : '') + n; }
function timeToStr_hhmmss_ms(date) { return str2(date.getUTCHours()) + ":" + str2(date.getUTCMinutes()) + ":" + str2(date.getUTCSeconds()) + "." + str3(date.getUTCMilliseconds()); }
function timeToStr_hhmmss(date) { return str2(date.getUTCHours()) + ":" + str2(date.getUTCMinutes()) + ":" + str2(date.getUTCSeconds()); }
function timeToStr_yyyymmdd_hhmm(date, dateDelim = "-") { return date.getUTCFullYear() + dateDelim + str2(date.getUTCMonth() + 1) + dateDelim + str2(date.getUTCDate()) + " " + str2(date.getUTCHours()) + ":" + str2(date.getUTCMinutes()); }
function timeToStr_yyyymmdd_hhmmss(date, dateDelim = "-") { return timeToStr_yyyymmdd_hhmm(date, dateDelim) + ":" + str2(date.getUTCSeconds()); }
function timeToStr_yyyymmdd_hhmmss_ms(date, dateDelim = "-") { return timeToStr_yyyymmdd_hhmmss(date, dateDelim) + "." + str3(date.getUTCMilliseconds()); }
function timeLocalToStr_hhmmss(date) { return str2(date.getHours()) + ":" + str2(date.getMinutes()) + ":" + str2(date.getSeconds()); }
function timeLocalToStr_hhmmss_ms(date) { return timeLocalToStr_hhmmss(date) + str3(date.getMilliseconds()); }
function timeLocalToStr_yyyymmdd(date, dateDelim = "-") { return date.getFullYear() + dateDelim + str2(date.getMonth() + 1) + dateDelim + str2(date.getDate()); }
function timeLocalToStr_yyyymmdd_hhmm(date, dateDelim = "-") { return timeLocalToStr_yyyymmdd(date, dateDelim) + " " + str2(date.getHours()) + ":" + str2(date.getMinutes()); }
function timeLocalToStr_yyyymmdd_hhmmss(date, dateDelim = "-") { return timeLocalToStr_yyyymmdd_hhmm(date, dateDelim) + ":" + str2(date.getSeconds()); }
function timeLocalToStr_yyyymmdd_hhmmss_ms(date, dateDelim = "-") { return timeLocalToStr_yyyymmdd_hhmmss(date, dateDelim) + "." + str3(date.getMilliseconds()); }
function timeToString_yyyymmdd_hhmm_offset(date) { let offset = date.getTimezoneOffset(); return timeLocalToStr_yyyymmdd_hhmm(date) + " GMT" + (offset < 0 ? '+' : '') + (-offset / 60); }
function timeToString_yyyymmdd_hhmmss_offset(date) { let offset = date.getTimezoneOffset(); return timeLocalToStr_yyyymmdd_hhmmss(date) + " GMT" + (offset < 0 ? '+' : '') + (-offset / 60); }
function format(date, pattern, opts) {
    let utc = opts?.utc ?? true;
    switch (pattern) {
        case 'HH:mm:ss': return utc ? timeToStr_hhmmss(date) : timeLocalToStr_hhmmss(date);
        case 'HH:mm:ss.SSS': return utc ? timeToStr_hhmmss_ms(date) : (timeLocalToStr_hhmmss(date) + '.' + str3(date.getMilliseconds()));
        case 'yyyy-MM-dd': return utc ? timeToStr_yyyymmdd_hhmm(date).slice(0, 10) : timeLocalToStr_yyyymmdd(date);
        case 'yyyy-MM-dd HH:mm': return utc ? timeToStr_yyyymmdd_hhmm(date) : timeLocalToStr_yyyymmdd_hhmm(date);
        case 'yyyy-MM-dd HH:mm:ss': return utc ? timeToStr_yyyymmdd_hhmmss(date) : timeLocalToStr_yyyymmdd_hhmmss(date);
        case 'yyyy-MM-dd HH:mm:ss.SSS': return utc ? timeToStr_yyyymmdd_hhmmss_ms(date) : timeLocalToStr_yyyymmdd_hhmmss_ms(date);
        case 'yyyy-MM-dd HH:mm O': return timeToString_yyyymmdd_hhmm_offset(date);
        case 'yyyy-MM-dd HH:mm:ss O': return timeToString_yyyymmdd_hhmmss_offset(date);
    }
}
Date.prototype.toString = function () { return timeToString_yyyymmdd_hhmmss_offset(this); };
Date.prototype.toDateString = function () { return timeLocalToStr_yyyymmdd(this); };
Date.prototype.toTimeString = function () { let offset = this.getTimezoneOffset(); return timeLocalToStr_hhmmss(this) + " GMT" + (offset < 0 ? '+' : '') + (-offset / 60); };
function _getStructCopyWithTimeStrings(arg, objectsMap) {
    if (!arg)
        return arg;
    if (arg instanceof Date)
        return arg.toString();
    let clone;
    if (Object.getPrototypeOf(arg) == Object.prototype)
        clone = {};
    else if (Object.getPrototypeOf(arg) == Array.prototype) {
        clone = [];
    }
    else
        return arg;
    let mapVal = objectsMap?.get(arg);
    if (mapVal)
        return mapVal;
    objectsMap ??= new Map();
    objectsMap.set(arg, clone);
    for (let key in arg)
        clone[key] = _getStructCopyWithTimeStrings(arg[key], objectsMap);
    return clone;
}
function convertDatesToStrings(arg) { return _getStructCopyWithTimeStrings(arg); }
function toPrintObject(arg) { return convertDatesToStrings(arg); }
function replaceConsoleCommands() {
    const consoleLog = console.log;
    const consoleWarn = console.warn;
    const consoleError = console.error;
    function replaceArgs(args) { return args.map(arg => convertDatesToStrings(arg)); }
    console.log = (...args) => { consoleLog(...replaceArgs(args)); };
    console.warn = (...args) => { consoleWarn(...replaceArgs(args)); };
    console.error = (...args) => { consoleError(...replaceArgs(args)); };
}
function durationToStr(duration_ms) {
    let units = [[exports.D1_MS, "д"], [exports.H1_MS, "ч"], [exports.M1_MS, "м"], [1000, "c"], [1, "мс"]];
    let firstUnit = null;
    let firstCount = 0;
    let str = "";
    for (let unit of units) {
        let unitCountFloat = duration_ms / unit[0];
        if (unitCountFloat < 1.1 && firstUnit == null)
            continue;
        if (firstUnit == null && unitCountFloat <= 10) {
            firstUnit = unit;
            firstCount = Math.floor(unitCountFloat);
            duration_ms %= unit[0];
            continue;
        }
        let unitCount = Math.round(unitCountFloat);
        if (firstUnit && unitCount * unit[0] >= firstUnit[0]) {
            firstCount++;
            unitCount = 0;
        }
        if (firstUnit)
            str += firstCount + firstUnit[1] + " ";
        if (unitCount > 0 || firstUnit == null)
            str += unitCount + unit[1] + " ";
        return str;
    }
    if (firstUnit)
        str += firstCount + firstUnit[1] + " ";
    return str;
}
function durationToStrNullable(duration_ms) { return duration_ms == null ? null : durationToStr(duration_ms); }
function durationToStr_h_mm_ss(duration_ms) {
    let time = new Date(duration_ms);
    return Math.trunc(duration_ms / exports.H1_MS) + ":" + str2(time.getUTCMinutes()) + ":" + str2(time.getUTCSeconds());
}
function durationToStr_h_mm_ss_ms(duration_ms) { return durationToStr_h_mm_ss(duration_ms) + "." + str3(Math.trunc(duration_ms % 1000)); }
function formatDuration(duration_ms, pattern = 'H:mm:ss') {
    return pattern == 'H:mm:ss.SSS' ? durationToStr_h_mm_ss_ms(duration_ms) : durationToStr_h_mm_ss(duration_ms);
}
async function sleepAsync(msec) {
    return new Promise((resolve, reject) => { setTimeout(resolve, msec); });
}
class CDelayer {
    remainPause = 0;
    async sleepAsync(pause_ms_getter) {
        let passed_ms = 0;
        let startRemainPause = this.remainPause;
        while (true) {
            let pause = pause_ms_getter();
            if (pause == null || pause < 0)
                return;
            this.remainPause = Math.max(startRemainPause + pause - passed_ms, 0);
            pause = Math.min(this.remainPause, 100);
            if (pause > 15) {
                let oldTime = Date.now();
                await sleepAsync(pause);
                let duration = Date.now() - oldTime;
                passed_ms += duration;
                this.remainPause -= duration;
            }
            else
                break;
        }
    }
}
exports.CDelayer = CDelayer;
function MinTime(time1, time2) {
    return time1 && time2 && time1.valueOf() <= time2.valueOf() ? time1 : time2 ?? time1;
}
function MaxTime(time1, time2) {
    return time1 && time2 && time1.valueOf() >= time2.valueOf() ? time1 : time2 ?? time1;
}
exports.minDate = MinTime;
exports.maxDate = MaxTime;
