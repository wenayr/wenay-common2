"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetAutoStepForElement = SetAutoStepForElement;
const common_1 = require("./core/common");
function SetAutoStepForElement(element, params = { maxStep: 1 }) {
    function parse(valueStr) { let val = parseFloat(valueStr); return isNaN(val) ? null : val; }
    const { minStep, maxStep = 1 } = params;
    const maxDigits = minStep ? (0, common_1.GetDblPrecision)(minStep) : undefined;
    const stepDefault = parse(element.step);
    const minDefault = parse(element.min);
    const maxDefault = parse(element.max);
    const minDigits = maxStep > 0 ? Math.max(0, -Math.round(Math.log10(maxStep))) : 0;
    let _digits = null;
    let _step = parse(element.step);
    let _min = parse(element.min);
    function calculateStep(valueStr) {
        let dotPos = valueStr.search(/\.|,/);
        let digits = (dotPos >= 0) ? valueStr.length - dotPos - 1 : 0;
        digits = Math.max(digits, minDigits);
        if (digits > 10)
            digits = (0, common_1.GetDblPrecision2)(parseFloat(valueStr), minDigits, 10);
        if (maxDigits != null)
            digits = Math.min(digits, maxDigits);
        let step = (0, common_1.NormalizeDouble)(Math.pow(0.1, digits), digits);
        if (minStep)
            step = (0, common_1.NormalizeDouble)(Math.round(step / minStep) * minStep, digits);
        if (maxDefault != null && minDefault != null)
            if (maxDefault - minDefault < step * 2)
                return _step;
        _digits = digits;
        _step = step;
        if (_min != null) {
            if (Math.abs(_min) % step > 1e-9 && step - Math.abs(_min) % step > 1e-9)
                _min = Math.floor(Math.abs(_min) / step) * step * Math.sign(minDefault);
            element.min = _min + "";
        }
        element.step = step + "";
        return step;
    }
    let modeAuto = !_step || (_step < 1 && Math.abs(Math.log10(_step) - Math.round(Math.log10(_step))) < 1e-9);
    const modeAuto0 = modeAuto;
    if (modeAuto) {
        calculateStep((_step ? (Math.round(parseFloat(element.value) / _step) * _step) : element.value) + "");
    }
    if (_step && minDefault && Math.abs(minDefault % _step) > 1e-10)
        modeAuto = false;
    else if (_step && maxDefault && Math.abs(maxDefault % _step) > 1e-10)
        modeAuto = false;
    else
        modeAuto ||= (_step != null && (minStep == null || _step > minStep));
    element.onkeyup = () => { if (modeAuto)
        calculateStep(element.value); };
    element.onchange = () => {
        let digits = _digits;
        if (digits != null)
            element.value = parseFloat(element.value).toFixed(digits);
        if (minDefault != null && parseFloat(element.value) < minDefault) {
            element.step = stepDefault + "";
            element.value = minDefault + "";
            element.min = minDefault + "";
            _digits = null;
        }
        element.setAttribute("value", element.value);
    };
}
