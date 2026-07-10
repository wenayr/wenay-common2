"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toRGBA = exports.hueRGB = exports.hue = void 0;
exports.rgb = rgb;
exports.colorGenerator = colorGenerator;
exports.colorGenerator2 = colorGenerator2;
exports.colorGeneratorByCount2 = colorGeneratorByCount2;
exports.colorGeneratorByCount = colorGeneratorByCount;
exports.colorStringToRGBA = colorStringToRGBA;
exports.toColorString = toColorString;
exports.isSimilarColors = isSimilarColors;
function rgb(red, green, blue) { return `rgb(${red},${green},${blue})`; }
function* colorGenerator(min = 0, max = 254) {
    for (let step = Math.floor((max - min) / 2); step >= 1; step /= 2) {
        let v = (max - min) / step;
        for (let rStep = 0, r = 0; rStep <= v; rStep++, r += step)
            for (let gStep = 0, g = 0; gStep <= v; gStep++, g += step)
                for (let bStep = 0, b = 0; bStep <= v; bStep++, b += step) {
                    if (r % (step * 2) == 0 && g % (step * 2) == 0 && b % (step * 2) == 0)
                        continue;
                    yield [Math.round(r) + min, Math.round(g) + min, Math.round(b) + min];
                }
    }
    yield [-1, -1, -1];
}
function* colorGenerator2(data) {
    const max = data?.max ?? 255;
    const min = data?.min ?? 0;
    function* _range(start = 0, end = 255) {
        const range = (end - start) * 5;
        for (let p = range; p > 1; p >>= 2) {
            for (let i = 1, step = p >> 2; step * i < range; i++)
                yield step * i;
        }
    }
    const d = max - min;
    let buf = [min, min, min];
    const rangeGen = _range(min, max);
    for (let num of rangeGen) {
        buf = [min, min, min];
        const p = Math.round(num / d);
        const r = num % d;
        if (p == 0) {
            buf[0] = max;
            buf[1] = min + r;
        }
        if (p == 1) {
            buf[0] = max - r;
            buf[1] = max;
        }
        if (p == 2) {
            buf[1] = max;
            buf[2] = min + r;
        }
        if (p == 3) {
            buf[1] = max - r;
            buf[2] = max;
        }
        if (p == 4) {
            buf[2] = max;
            buf[0] = min + r;
        }
        if (p == 5) {
            buf[2] = max - r;
            buf[0] = max;
        }
        yield buf;
    }
    yield [-1, -1, -1];
}
function colorGeneratorByCount2(value = 180, count = 100, index = 1) {
    const step = Math.floor(value * 6 * index / count);
    const p = Math.floor(step / value) % 6;
    const z = Math.floor(step % value);
    const r = (p == 0 || p == 5) ? value : (p == 1) ? value - z : (p == 4) ? z : 0;
    const g = (p == 1 || p == 2) ? value : (p == 3) ? value - z : (p == 0) ? z : 0;
    const b = (p == 3 || p == 4) ? value : (p == 5) ? value - z : (p == 2) ? z : 0;
    return [r, g, b];
}
function colorGeneratorByCount(value = 180, count = 100, index = 1) {
    const [r, g, b] = colorGeneratorByCount2(value, count, index);
    return `rgb(${r},${g},${b})`;
}
exports.hue = colorGeneratorByCount;
exports.hueRGB = colorGeneratorByCount2;
function colorStringToRGBA(str) {
    const rgbRegex = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i;
    const rgbaRegex = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d*\.?\d+)\s*\)$/i;
    let match = str.match(rgbRegex);
    if (match) {
        const [r, g, b] = match.slice(1).map(Number);
        if (isValidRGBValue(r) && isValidRGBValue(g) && isValidRGBValue(b)) {
            return [r, g, b, 1];
        }
    }
    match = str.match(rgbaRegex);
    if (match) {
        const [r, g, b, a] = match.slice(1).map(Number);
        if (isValidRGBValue(r) && isValidRGBValue(g) && isValidRGBValue(b) && isValidAlphaValue(a)) {
            return [r, g, b, a];
        }
    }
    return undefined;
}
exports.toRGBA = colorStringToRGBA;
function isValidRGBValue(value) {
    return value >= 0 && value <= 255;
}
function isValidAlphaValue(value) {
    return value >= 0 && value <= 1;
}
function toColorString(str) { if (colorStringToRGBA(str))
    return str; throw `the string '${str}' is not valid 'rgb' or 'rgba' string`; }
function isSimilarColors(color1, color2, maxDelta = 32) {
    let c1 = typeof color1 == "string" ? colorStringToRGBA(color1) : color1;
    let c2 = typeof color2 == "string" ? colorStringToRGBA(color2) : color2;
    if (!c1 || !c2)
        return false;
    let [r1, g1, b1] = c1;
    let [r2, g2, b2] = c2;
    let delta = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
    return delta <= maxDelta;
}
