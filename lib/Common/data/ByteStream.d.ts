import { const_Date } from "../core/BaseTypes";
export type NumericTypes = "int8" | "int16" | "int24" | "int32" | "int48" | "int64" | "float" | "double" | "uint8" | "uint16" | "uint24" | "uint32" | "uint48" | "uint64";
export declare class Nullable<T extends NumericTypes> {
    value: T;
    constructor(type: T);
}
export declare function nullable(type: NumericTypes): Nullable<NumericTypes>;
export type WritableToBytes = {
    write(stream: ByteStreamW): boolean | void;
};
export declare class ByteStreamW {
    protected _view: DataView;
    protected _pos: number;
    protected _isThrowable: boolean;
    protected _buffer(): ArrayBufferLike;
    protected resize(size: number): void;
    constructor(view?: DataView);
    get length(): number;
    get data(): Readonly<DataView>;
    noThrow(): ByteStreamW;
    private _ensureAllocation;
    private _setInt8;
    private _setInt16;
    private _setInt32;
    protected _push(value: number, bytes: number, isInteger: boolean): this;
    pushInt8(value: number): this;
    pushInt16(value: number): this;
    pushInt24(value: number): this;
    pushInt32(value: number): this;
    pushInt48(value: number): this;
    pushInt64(value: number): this;
    pushFloat(value: number): this;
    pushDouble(value: number): this;
    pushBool(value: boolean): this;
    pushDate(value: const_Date): this;
    private _checkResult;
    push(obj: WritableToBytes): this | null;
    pushNullable(obj: WritableToBytes | null): this | null;
    pushNumber(value: number, type: NumericTypes | Nullable<NumericTypes>): boolean;
    pushNumbers(values: readonly number[], type: NumericTypes | Nullable<NumericTypes>): this | null;
    pushArrayByFunc<T>(array: Iterable<T>, func: (stream: ByteStreamW, item: T) => boolean | void, maxlength?: number): this | null;
    protected _getWriteFuncForNumeric(type: NumericTypes | Nullable<NumericTypes>): (stream: ByteStreamW, value: number | null) => boolean;
    pushArrayNumeric(array: Iterable<number>, type: NumericTypes | Nullable<NumericTypes>, maxlength?: number): this | null;
    pushArray<T extends WritableToBytes>(array: Iterable<T> | Int8Array | Uint8Array, maxlength?: number): this | null;
    pushArrayOfNullable<T extends WritableToBytes | null>(array: Iterable<T>, maxlength?: number): this | null;
    private _pushNullableString;
    pushAnsi(text: string | null): this;
    pushUnicode(text: string | null): this;
}
type ReaderFromBytes<T> = {
    read(stream: ByteStreamR): T;
};
declare class ByteStreamR_<throwable extends boolean> {
    protected _wstream?: Readonly<ByteStreamW>;
    protected _view: Readonly<DataView>;
    protected _pos: number;
    private isThrowable;
    constructor(data: Readonly<ArrayBuffer | DataView>);
    UpdateFrom(stream: Readonly<ByteStreamW>): void;
    private __readNumber;
    _readNumber(bytes: number, isInteger: boolean, isSigned?: boolean): (throwable extends true ? number : number | null);
    noThrow(): ByteStreamR_<false>;
    readInt8(): throwable extends true ? number : number | null;
    readInt16(): throwable extends true ? number : number | null;
    readInt24(): throwable extends true ? number : number | null;
    readInt32(): throwable extends true ? number : number | null;
    readInt48(): throwable extends true ? number : number | null;
    readInt64(): throwable extends true ? number : number | null;
    readUint8(): throwable extends true ? number : number | null;
    readUint16(): throwable extends true ? number : number | null;
    readUint24(): throwable extends true ? number : number | null;
    readUint32(): throwable extends true ? number : number | null;
    readUint48(): throwable extends true ? number : number | null;
    readUint64(): throwable extends true ? number : number | null;
    readFloat(): throwable extends true ? number : number | null;
    readDouble(): throwable extends true ? number : number | null;
    readBool(): (throwable extends true ? boolean : boolean | null);
    readNumber(type: NumericTypes | Nullable<NumericTypes>): throwable extends true ? number : number | null;
    readDate(): Date;
    toType<T>(value: T): (throwable extends true ? T : T | null);
    protected _getReadFuncForNumeric<T extends NumericTypes | Nullable<NumericTypes>>(type: T): (stream: ByteStreamR_<throwable>) => throwable extends true ? number : T extends NumericTypes ? number : number | null;
    readNullable<T>(reader: ReaderFromBytes<NonNullable<T>>): NonNullable<T> | null;
    readArray<T>(func: (stream: ByteStreamR) => NonNullable<T>): T[];
    readArray<T extends NumericTypes | Nullable<NumericTypes>>(type: T): T extends NumericTypes ? number[] : (number | null)[];
    readArray<T>(reader: ReaderFromBytes<NonNullable<T>>): T[];
    protected _readArrayByFunc<T>(func: (stream: ByteStreamR) => T): T[] | null;
    protected _readArrayOfNumeric(type: NumericTypes): any;
    protected _readArrayByReader<T>(reader: ReaderFromBytes<T>): T[] | null;
    private _readNullableString;
    readAnsi(): string | null;
    readUnicode(): string | null;
}
export declare class ByteStreamR extends ByteStreamR_<true> {
    constructor(data: Readonly<ArrayBuffer | DataView>);
}
export {};
