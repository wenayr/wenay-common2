declare type Nominal<T, Name extends string> = T & {
    [Symbol.species]: Name;
};
export type ColorNumber = Nominal<number, 'Color'>;
export type ColorString = `rgb(${number},${number},${number})` | `rgba(${number},${number},${number},${number})` | `#${string}`;
export type ColorRGB = Readonly<{
    red: number;
    green: number;
    blue: number;
}>;
export type ColorRGBA = Readonly<{
    red: number;
    green: number;
    blue: number;
    alpha: number;
}>;
export type ColorAny = ColorNumber | ColorString | Readonly<ColorRGBA>;
export type Color = ColorString;
export declare function rgb(red: number, green: number, blue: number): ColorString;
export declare function colorGenerator(min?: number, max?: number): Generator<[number, number, number]>;
export declare function colorGenerator2(data?: {
    min?: number;
    max?: number;
}): Generator<[number, number, number]>;
export declare function colorGeneratorByCount2(value?: number, count?: number, index?: number): [number, number, number];
export declare function colorGeneratorByCount(value?: number, count?: number, index?: number): ColorString;
export declare const hue: typeof colorGeneratorByCount;
export declare const hueRGB: typeof colorGeneratorByCount2;
export declare function colorStringToRGBA(str: ColorString): [number, number, number, number];
export declare function colorStringToRGBA(str: string): [number, number, number, number] | undefined;
export declare const toRGBA: typeof colorStringToRGBA;
export declare function toColorString(str: string): ColorString;
export declare function isSimilarColors(color1: ColorString | readonly [number, number, number], color2: ColorString | readonly [number, number, number], maxDelta?: number): boolean;
export {};
