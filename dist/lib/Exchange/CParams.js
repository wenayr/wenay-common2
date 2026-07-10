"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromValues = exports.toValues = exports.CParamsReadonly = exports.CParams = void 0;
exports.isParamBase = isParamBase;
exports.isParamGroupOrArray = isParamGroupOrArray;
exports.isParamGroup = isParamGroup;
exports.isSimpleParams2 = isSimpleParams2;
exports.isSimpleParams = isSimpleParams;
exports.iterateParams = iterateParams;
exports.enableAllParams = enableAllParams;
exports.GetSimpleParams = GetSimpleParams;
exports.mergeParamValuesToInfos = mergeParamValuesToInfos;
const common_1 = require("../Common/core/common");
function _typeCheck_DateTimeStr() {
    let ts = "2025-06-01 16:25:25";
    return ts;
}
function _typeCheck_IParamEnum2() { let x = { value: 5, range: [5, 6] }; return x; }
let dd;
function isParamBase(param) {
    return typeof param == "object" && !Array.isArray(param) && !(param instanceof Date);
}
class CParams {
}
exports.CParams = CParams;
class CParamsReadonly {
}
exports.CParamsReadonly = CParamsReadonly;
function isParamGroupOrArray(param) {
    return typeof param == "object" && typeof param.value == "object" && !(param.value instanceof Date);
}
function isParamGroup(param) {
    return isParamGroupOrArray(param) && !Array.isArray(param.value);
}
function isSimpleParams2(params) {
    let t = false;
    for (let key in params) {
        const tr = params[key]["value"];
        if (tr == null)
            return true;
        else {
            if (typeof tr == "object") {
                const r = isSimpleParams(tr);
                if (r)
                    return true;
            }
        }
    }
    return false;
}
function isSimpleParams(params) {
    for (let key in params) {
        const param = params[key];
        if (param == null || typeof param !== "object") {
            return true;
        }
        if (!("value" in param)) {
            return true;
        }
        const val = param.value;
        if (typeof val === "object" && val !== null && !(val instanceof Date) && !Array.isArray(val)) {
            const r = isSimpleParams(val);
            if (r)
                return true;
        }
    }
    return false;
}
function* iterateParams(obj, currentPath = []) {
    for (let [key, param] of Object.entries(obj)) {
        let keyPath = currentPath.concat(key);
        yield [key, param, keyPath];
        if (typeof param == "object") {
            const valKey = "value";
            let value = param[valKey];
            if (typeof value == "object" && !(0, common_1.isDate)(value) && !Array.isArray(value))
                yield* iterateParams(value, keyPath.concat(valKey));
        }
    }
}
function enableAllParams(params, enabled = true) {
    const paramsInfoClone = (0, common_1.deepCloneMutable)(params);
    for (let [key, param] of iterateParams(paramsInfoClone)) {
        if (isParamBase(param) && param.enabled != null)
            param.enabled = enabled;
        if (isParamBase(param) && param.elementsEnabled != null)
            param.elementsEnabled = enabled;
    }
    return paramsInfoClone;
}
function _typeCheck_CParamsReadonly() {
    class C extends CParams {
        lastBar = { name: "Last_Bar", value: 0, range: { defaultMin: -10000, max: 0, step: 1 } };
    }
    let xxx = {};
    let bbb = xxx;
    return bbb;
}
const param = {
    p0: { name: "MA0", value: [10, 20], range: [10, 20, 30] },
    p1: { name: "MA1", commentary: ["fgf"], value: 20, range: { min: 10, max: 20, step: 2 } },
    p2: { name: "MA2", value: 10, range: [10, 20, 30] },
    p3: { name: "MA3", value: "a", range: ["a", "b", "c"] },
    p4: { name: "MA4", value: true },
    p5: {
        name: "group",
        commentary: ["group for... "],
        enabled: true,
        value: {
            p1: { name: "gMA1", value: 20, range: { min: 10, max: 20, step: 2 } },
            p2: { name: "gMA2", value: 10, range: [10, 20, 30] }
        }
    },
    p6: 10,
    p7: { name: "time", value: "2020-01-05 12:46", type: "time", range: { min: "2020-01-05 00:00", max: "2020-01-05 00:00", step: 200 } },
    p8: { name: "time2", value: new Date() }
};
class CCC extends CParams {
    time = { name: "Time", value: "2020-01-05 12:46", type: "time" };
    text = { value: "text", type: "symbol" };
}
class Test2 {
    p0 = 123;
    p1 = "213";
    p2 = [10, 20, 30];
    p3 = "a";
    p4 = true;
    p5 = {
        enabled: true,
        p1: "gMA1",
        p2: "gMA2"
    };
}
class Test extends CParams {
    p0 = { name: "MA0", value: [10, 20], range: [10, 20, 30] };
    p1 = { name: "MA1", value: 20, range: { min: 10, max: 20, step: 2 } };
    p2 = { name: "MA2", value: 10, range: [10, 20, 30] };
    p3 = { name: "MA3", value: "a", range: ["a", "b", "c"] };
    p4 = { name: "MA4", value: true, commentary: ["Dsd"] };
    p5 = {
        name: "group",
        enabled: true,
        value: {
            p1: { name: "gMA1", value: 20, range: { min: 10, max: 20, step: 2 } },
            p2: { name: "gMA2", value: 10, range: [10, 20, 30] }
        }
    };
}
function TestFunction() {
    return {
        p0: { name: "MA0", value: [10, 20], range: [10, 20, 30] },
        p1: { name: "MA1", value: 20, range: { min: 10, max: 20, step: 2 } },
        p2: { name: "MA2", value: 10, range: [10, 20, 30] },
        p3: { name: "MA3", value: "a", range: ["a", "b", "c"] },
        p4: { name: "MA4", value: true, commentary: ["Dsd"] },
        p5: {
            name: "group",
            enabled: true,
            value: {
                p1: { name: "gMA1", value: 20, range: { min: 10, max: 20, step: 2 } },
                p2: { name: "gMA2", value: 10, range: [10, 20, 30] }
            }
        }
    };
}
function GetSimpleParams(params) {
    const simpleParamsBase = params instanceof Array ? [] : {};
    let simpleParams = simpleParamsBase;
    for (let key in params) {
        const param = params[key];
        simpleParams[key] =
            typeof (param) == "function" ? param() :
                typeof (param) != "object" ? param :
                    param == null ? null :
                        param.enabled == false ? null :
                            typeof (param.value) != "object" ? param.value :
                                param.value instanceof Array ? (param.value.filter((item, i) => Array.isArray(param.elementsEnabled) ? param.elementsEnabled[i] : param.elementsEnabled != false)) :
                                    param.value instanceof Date ? new Date(param.value) :
                                        GetSimpleParams(param.value);
    }
    return simpleParams;
}
exports.toValues = GetSimpleParams;
function _typeCheck_GetSimpleParams() {
    let p = GetSimpleParams(new Test());
    let p0 = p.p1;
    let p3 = p.p3;
    let p4 = p.p4;
    let p5 = p.p5?.p1;
    return [p0, p3, p4, p5];
}
function convert_(valuesObj, srcObj) {
    let resObj = {};
    if (srcObj instanceof Array)
        if (valuesObj instanceof Array)
            return [...valuesObj];
        else
            return srcObj;
    for (let key in srcObj) {
        const srcval = srcObj[key];
        resObj[key] = (() => {
            const val = valuesObj[key];
            if (val == undefined) {
                if (typeof srcval == "object" && srcval.enabled != undefined)
                    return { ...srcval, enabled: false };
            }
            if (typeof srcval == "boolean") {
                if (typeof val == "boolean")
                    return val;
            }
            if (typeof srcval == "object") {
                let srcvalue = srcval.value;
                if (srcvalue == null)
                    return srcval;
                const resVal = { ...srcval };
                if (srcvalue instanceof Date && (typeof val == "string" || val instanceof Date))
                    resVal.value = new Date(val);
                else if (typeof srcvalue != typeof val)
                    return srcval;
                else if (typeof srcvalue != "object")
                    resVal.value = val;
                else if (Array.isArray(val)) {
                    resVal.value = [...val];
                    if (resVal.elementsEnabled != null)
                        resVal.elementsEnabled = true;
                }
                else
                    resVal.value = convert_(val, srcvalue);
                if (srcval.enabled != undefined)
                    resVal.enabled = true;
                return resVal;
            }
            return srcval;
        })();
    }
    return resObj;
}
function mergeParamValuesToInfos(srcObj, valuesObj) {
    return convert_(isSimpleParams(valuesObj) ? valuesObj : GetSimpleParams(valuesObj), srcObj);
}
exports.fromValues = mergeParamValuesToInfos;
function test() {
    {
        const p = new Test();
        const s = GetSimpleParams(p);
        const r = mergeParamValuesToInfos(p, s);
        console.log(p, s, r);
    }
    {
    }
}
