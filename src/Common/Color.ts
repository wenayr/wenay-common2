declare type Nominal<T, Name extends string> = T & { [Symbol.species]: Name; }

// // Создаём числовой тип Index
// type Index = Nominal<number, 'Index'>;
//
// let index : Index;
//
// index= 42; // Ошибка
//
// index = 42 as Index;  // OK


export type ColorNumber = Nominal<number, 'Color'>;

type HEXSymbol = "0"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"A"|"B"|"C"|"D"|"E"|"F";

type HEXPair= `${HEXSymbol}${HEXSymbol}`;

//type HXX= `#${HEXPair}${HEXPair}${HEXPair}`;

//export type ColorString = Nominal<string, 'ColorString'>;
//type RgbString= `rgb(${number},${number},${number})` | `rgba(${number},${number},${number},${number})`;
//type HexString = `#${HEXSymbol}${HEXSymbol}${HEXSymbol}${HEXSymbol}${HEXSymbol}${HEXSymbol}`;

export type ColorString = `rgb(${number},${number},${number})` | `rgba(${number},${number},${number},${number})` | `#${string}`; // | ;

export type ColorRGB = Readonly<{ red :number;  green :number;  blue :number; }>;

export type ColorRGBA = Readonly<{ red :number;  green :number;  blue :number;  alpha :number }>;

export type ColorAny = ColorNumber | ColorString | Readonly<ColorRGBA>;

export type Color = ColorString;

export function rgb(red :number, green :number, blue :number) : ColorString { return `rgb(${red},${green},${blue})`; } // Генератор цветов

// min - минимальная яркость/диапазон
// max - максимальная яркость/диапазон
export function* colorGenerator(min= 0 , max= 254): Generator<[number, number, number]> {
    for (let step= Math.floor((max - min)/2); step>=1; step/=2) {
        let v= (max - min)/step;
        for (let rStep=0, r=0; rStep<=v; rStep++, r+=step)
            for (let gStep=0, g=0; gStep<=v; gStep++, g+=step)
                for (let bStep=0, b=0; bStep<=v; bStep++, b+=step) {
                    if (r%(step*2)==0 && g%(step*2)==0 && b%(step*2)==0)
                        continue;
                    yield [Math.round(r) + min, Math.round(g) + min, Math.round(b) + min]
                }
    }
    yield [-1, -1, -1];
}

// максимальный разбор оттенков в одном цветовом контрасте
// min - контрастность, 0 - максимальное значение
export function* colorGenerator2(data?: { min?: number, max?: number}): Generator<[number, number, number]> {
    const max = data?.max ?? 255
    const min = data?.min ?? 0
    // startColor?: [r: number, g: number, b: number, number?] | ColorString,   , startColor:_clr
    // const startColor = !_clr ? colorStringToRGBA("rgb(0,255,0)") :
    //     typeof _clr == "object" ? _clr :  colorStringToRGBA(_clr)
    // let [r,g,b] = startColor

    function* _range(start = 0, end = 255){
        const range = (end - start) * 5
        for (let p = range; p > 1; p >>= 2) {
            for (let i = 1, step = p >> 2; step * i < range; i++)
                yield step * i
        }
    }

    const d = max - min
    let buf: [number, number, number] = [min, min, min]
    const rangeGen = _range(min , max)
    for (let num of rangeGen) {
        buf = [min, min, min]
        const p = Math.round(num/d)
        const r = num%d
        if (p == 0) {
            buf[0] = max
            buf[1] = min + r
        }
        if (p == 1) {
            buf[0] = max - r
            buf[1] = max
        }
        if (p == 2) {
            buf[1] = max
            buf[2] = min + r
        }
        if (p == 3) {
            buf[1] = max - r
            buf[2] = max
        }
        if (p == 4) {
            buf[2] = max
            buf[0] = min + r
        }
        if (p == 5) {
            buf[2] = max - r
            buf[0] = max
        }
        yield buf
    }
    yield [-1, -1, -1];
}

//светлость оттенков
export function colorGeneratorByCount2(value=180, count=100, index=1): [number, number, number] {
    const step = Math.floor(value * 6 * index / count)
    const p = Math.floor(step / value)
    const z = Math.floor(step % value)
    const r = (p==0 || p==5) ? value : (p==1) ? value-z : (p==4) ? z : 0
    const g = (p==1 || p==2) ? value : (p==3) ? value-z : (p==0) ? z : 0
    const b = (p==3 || p==4) ? value : (p==5) ? value-z : (p==2) ? z : 0
    return [r,g,b];
}
export function colorGeneratorByCount(value=180, count=100, index=1) : ColorString {
    const [r,g,b] = colorGeneratorByCount2(value, count, index)
    return `rgb(${r},${g},${b})`;
}

export function colorStringToRGBA(str :ColorString) : [number,number,number,number];
export function colorStringToRGBA(str :string) : [number,number,number,number]|undefined;

export function colorStringToRGBA(str: string): [number, number, number, number] | undefined {
    const rgbRegex = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i;
    const rgbaRegex = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d*\.?\d+)\s*\)$/i;

    let match = str.match(rgbRegex);
    if (match) {
        const [r, g, b] = match.slice(1).map(Number);
        if (isValidRGBValue(r) && isValidRGBValue(g) && isValidRGBValue(b)) {
            return [r, g, b, 1]; // Альфа по умолчанию: 1
        }
    }

    match = str.match(rgbaRegex);
    if (match) {
        const [r, g, b, a] = match.slice(1).map(Number);
        if (isValidRGBValue(r) && isValidRGBValue(g) && isValidRGBValue(b) && isValidAlphaValue(a)) {
            return [r, g, b, a];
        }
    }

    return undefined; // Возвращаем undefined для некорректных строк
}

// Проверяет, является ли значение RGB допустимым (0-255)
function isValidRGBValue(value: number): boolean {
    return value >= 0 && value <= 255;
}

// Проверяет, является ли значение альфа-канала допустимым (0.0-1.0)
function isValidAlphaValue(value: number): boolean {
    return value >= 0 && value <= 1;
}

export function toColorString(str :string) { if (colorStringToRGBA(str)) return str as ColorString;  throw `the string '${str}' is not valid 'rgb' or 'rgba' string`; }

// Проверяет цвета на схожесть по заданной максимальной дельте
export function isSimilarColors(color1 :ColorString|readonly[number,number,number], color2 :ColorString|readonly[number,number,number], maxDelta = 32) {
	let [r1, g1, b1] = typeof color1=="string" ? colorStringToRGBA(color1) : color1;
	let [r2, g2, b2] = typeof color2=="string" ? colorStringToRGBA(color2) : color2;
	let delta = Math.abs(r1-r2) + Math.abs(g1-g2) + Math.abs(b1-b2);
	return delta <= maxDelta;
}

