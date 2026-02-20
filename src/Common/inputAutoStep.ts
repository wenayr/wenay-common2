///??<reference lib="dom"/>
//import {HTMLInputElement} from "dom"
declare interface Event {}
declare type HTMLInputElement = {
    min: string, max: string, step :string, value :string, onchange :((ev :any)=>void)|null, onkeyup :((ev :any)=>void)|null, setAttribute(attr :string, val :string) :void,
};

//let aaa : HTMLInputElement = new globalThis.HTMLInputElement;


import {NormalizeDouble, MaxCommonDivisor,GetDblPrecision, GetDblPrecision2} from "./common";
//import * as lib from "./common"

// задать автоматическое управление шагом для элемента input
export function SetAutoStepForElement(element :HTMLInputElement, params :{minStep? :number|undefined, maxStep? :number} = { maxStep: 1})
{
	function parse(valueStr :string) { let val= parseFloat(valueStr);  return isNaN(val) ? null : val; }
    const {minStep, maxStep=1} = params;
    const maxDigits= minStep ? GetDblPrecision(minStep) : undefined;
	const stepDefault= parse(element.step);
	const minDefault= parse(element.min);
	const maxDefault= parse(element.max);
    const minDigits= maxStep>0 ? Math.max(0, -Math.round(Math.log10(maxStep))) : 0;
	let _digits :number|null= null;
	let _step= parse(element.step);
	let _min= parse(element.min);

	function calculateStep(valueStr :string) {
		//function NormalizeDouble(value :number, digits :number) { let factor=Math.pow(10, digits); return Math.round(value * factor)/factor;  }
		//if (dotPos===valueStr.length-1) dotPos--;
		//let digits= GetDblPrecision2(parseFloat(valueStr), minDigits, 10);
        let dotPos= valueStr.search(/\.|,/);  // Находим точку или запятую
		let digits = (dotPos>=0) ?  valueStr.length - dotPos - 1  : 0;
        digits= Math.max(digits, minDigits);
        if (digits>10) digits= GetDblPrecision2(parseFloat(valueStr), minDigits, 10);
        if (maxDigits!=null) digits= Math.min(digits, maxDigits);
		let step= NormalizeDouble(Math.pow(0.1, digits), digits);
        if (minStep) step = NormalizeDouble(Math.round(step/minStep) * minStep, digits);
		if (maxDefault!=null && minDefault!=null)
			if (maxDefault - minDefault < step*2)
				return _step;
		_digits= digits;
		_step= step;
		//if (Math.abs(min) < step) min= Math.floor(Math.abs(min)/step)*step * Math.sign(min);
		if (_min!=null) {
			if (Math.abs(_min) % step !=0)
				_min= Math.floor(Math.abs(_min)/step) * step * Math.sign(minDefault!);
			element.min= _min+"";
		}
		//console.log("step:",element.step+"->"+step," min:",element.min+"->"+min);
		//console.log("minDefault:",_minDefault,parseFloat(_minDefault));
		element.step= step+"";
		//console.log("dotPos:",dotPos," _digits:",_digits, "minDigits:",minDigits);
		return step;  ////lib.GetDblPrecision($fee[0].value)); }
	}
	let modeAuto = !_step || (_step<1 && Math.log10(_step-Math.trunc(_step))%1==0);  // является степенью 0.1
	const modeAuto0= modeAuto;
	if (modeAuto) {
		calculateStep((_step ? (Math.round(parseFloat(element.value)/_step) *_step) : element.value)+"");
		//console.log(element.value, step);
	}
    if (_step && minDefault && Math.abs(minDefault%_step) > 1e-10)
        modeAuto= false;
    else
    if (_step && maxDefault && Math.abs(maxDefault%_step) > 1e-10)
        modeAuto= false;
    else modeAuto ||= (_step!=null && (minStep==null || _step>minStep));

    //console.log("###",{value: element.value, modeAuto0, modeAuto, _step, _digits});

    //element.onkeydown= (e)=> { if (_step) element.step = "0.00000001"; /*String(_step/10);*/  console.log("keydown", {value: element.value}); }
	//element.onkeyup= ()=>{ if (_step) element.step= _step+"";  console.log("keyup", {modeAuto, value: element.value, step: calculateStep(element.value), _digits});  if (modeAuto) calculateStep(element.value); }// console.log(element.step); }//  console.log(element.value, element.step); }
	element.onkeyup= ()=>{ if (modeAuto) calculateStep(element.value); }// console.log(element.step); }//  console.log(element.value, element.step); }

	element.onchange= ()=> { //console.log("~~~",element.value, element.step);
		let digits= _digits;  if (digits!=null)  element.value= parseFloat(element.value).toFixed(digits);
        //console.log("change", {value: element.value, digits, minDigits});
		if (minDefault!=null && parseFloat(element.value) < minDefault) {
			element.step = stepDefault+"";
			element.value= minDefault+"";
			element.min= minDefault+"";
			_digits= null;
		}
		element.setAttribute("value", element.value);
	}//Math.round($fee[0].value/$fee[0].step)*$fee[0].step; }
	//element.onkeyup();
}

//import * as Time from "./Time"
//import {const_Date} from "./Time";





