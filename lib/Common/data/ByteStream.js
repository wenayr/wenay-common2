"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ByteStreamR = exports.ByteStreamW = exports.Nullable = void 0;
exports.nullable = nullable;
function createCopyOfBuffer(src, length = src.byteLength) {
    let dst = new ArrayBuffer(length);
    const bytes = src instanceof DataView
        ? new Uint8Array(src.buffer, src.byteOffset, Math.min(src.byteLength, length))
        : new Uint8Array(src, 0, Math.min(src.byteLength, length));
    new Uint8Array(dst).set(bytes);
    return dst;
}
class Nullable {
    value;
    constructor(type) { this.value = type; }
}
exports.Nullable = Nullable;
function nullable(type) { return new Nullable(type); }
function __getNumericTypeInfo(type) {
    switch (type) {
        case "int8": return [1];
        case "uint8": return [1, false];
        case "int16": return [2];
        case "uint16": return [2, false];
        case "int24": return [3];
        case "uint24": return [3, false];
        case "int32": return [4];
        case "uint32": return [4, false];
        case "int48": return [6];
        case "uint48": return [6, false];
        case "int64": return [8];
        case "uint64": return [8, false];
        case "float": return [4, true, false];
        case "double": return [8, true, false];
        default: throw "wrong type: " + type;
    }
}
;
function getNumericTypeInfo(type) {
    let [size, signed = true, integer = true] = __getNumericTypeInfo(type) ?? [0];
    if (!size)
        return null;
    return { size, signed, integer };
}
class ByteStreamW {
    _view = new DataView(new ArrayBuffer(0));
    _pos = 0;
    _isThrowable = true;
    _buffer() { return this._view?.buffer; }
    resize(size) {
        let buf = createCopyOfBuffer(this._view, size);
        this._view = new DataView(buf);
    }
    constructor(view) {
        if (view) {
            this._view = view;
        }
        else {
            this.resize(0);
        }
    }
    get length() { return this._pos; }
    get data() { return new DataView(this._buffer(), this._view.byteOffset, this._pos); }
    noThrow() { let other = new ByteStreamW(this._view); other._pos = this._pos; other._isThrowable = false; return other; }
    _ensureAllocation(bytes) {
        let minSize = this._pos + bytes;
        if (minSize > this._view.byteLength)
            for (let extraSize = Math.max(minSize * 0.5, 32); extraSize >= 0; extraSize /= 2) {
                try {
                    this.resize(minSize + extraSize);
                    break;
                }
                catch (e) {
                    if (extraSize < 1)
                        throw (e);
                }
            }
    }
    _setInt8(pos, value) { this._view.setInt8(pos, value); }
    _setInt16(pos, value) { this._view.setInt16(pos, value); }
    _setInt32(pos, value) { this._view.setInt32(pos, value); }
    _push(value, bytes, isInteger) {
        let pos = this._pos;
        this._ensureAllocation(bytes);
        let view = this._view;
        if (isNaN(value))
            throw "Failed to save NaN";
        if (isInteger && !Number.isInteger(value))
            throw "Failed to save value " + value + " as integer";
        if (isInteger)
            switch (bytes) {
                case 1:
                    this._setInt8(pos, value);
                    break;
                case 2:
                    this._setInt16(pos, value);
                    break;
                case 3:
                    this._setInt16(pos, value);
                    this._setInt8(pos + 2, value >> 16);
                    break;
                case 4:
                    this._setInt32(pos, value);
                    break;
                case 6:
                    this._setInt32(pos, value);
                    this._setInt16(pos + 4, Math.floor(value / 0x100000000));
                    break;
                case 8:
                    this._setInt32(pos, value);
                    this._setInt32(pos + 4, Math.floor(value / 0x100000000));
                    break;
                default: throw ("Wrong byte length: " + bytes);
            }
        else
            switch (bytes) {
                case 4:
                    view.setFloat32(pos, value);
                    break;
                case 8:
                    view.setFloat64(pos, value);
                    break;
                default: throw ("Wrong byte length: " + bytes);
            }
        this._pos += bytes;
        return this;
    }
    pushInt8(value) { return this._push(value, 1, true); }
    pushInt16(value) { return this._push(value, 2, true); }
    pushInt24(value) { return this._push(value, 3, true); }
    pushInt32(value) { return this._push(value, 4, true); }
    pushInt48(value) { return this._push(value, 6, true); }
    pushInt64(value) { return this._push(value, 8, true); }
    pushFloat(value) { return this._push(value, 4, false); }
    pushDouble(value) { return this._push(value, 8, false); }
    pushBool(value) { return this.pushInt8(value == true ? 1 : 0); }
    pushDate(value) { return this.pushInt64(value.valueOf()); }
    _checkResult(result, msg) { if (result == false && this._isThrowable)
        throw ("Failed to write " + msg); return result != false; }
    push(obj) { let ok = obj.write(this); return this._checkResult(ok, () => "object") ? this : null; }
    pushNullable(obj) { let ok = this.pushBool(obj != null) ? obj?.write(this) : false; return this._checkResult(ok, () => "object") ? this : null; }
    pushNumber(value, type) { return this._getWriteFuncForNumeric(type)(this, value); }
    pushNumbers(values, type) { for (let value of values)
        if (!this.pushNumber(value, type))
            return null; return this; }
    pushArrayByFunc(array, func, maxlength) {
        let oldpos = this._pos;
        this.pushInt32(0);
        let i = 0;
        for (let value of array) {
            if (func(this, value) == false)
                if (this._isThrowable)
                    throw ("Failed to write array item №" + i);
                else
                    return null;
            i++;
            if (i === maxlength)
                break;
        }
        this._view.setUint32(oldpos, i);
        return this;
    }
    _getWriteFuncForNumeric(type) {
        let isNullable = false;
        if (type instanceof Nullable) {
            type = type.value;
            isNullable = true;
        }
        let typeInfo = getNumericTypeInfo(type);
        if (!typeInfo)
            throw ("Wrong type: " + type);
        return (stream, value) => {
            if (isNullable) {
                if (stream.pushBool(value != null) == null)
                    return false;
                if (value == null)
                    return true;
            }
            return stream._push(value, typeInfo.size, typeInfo.integer) != null;
        };
    }
    pushArrayNumeric(array, type, maxlength) {
        return this.pushArrayByFunc(array, this._getWriteFuncForNumeric(type), maxlength);
    }
    pushArray(array, maxlength) {
        if (array instanceof Int8Array || array instanceof Uint8Array) {
            let length = Math.min(array.length, maxlength ?? array.length);
            this._ensureAllocation(length + 4);
            this.pushInt32(length);
            let arrayClass = (array instanceof Int8Array) ? Int8Array : Uint8Array;
            new arrayClass(this._buffer(), this._view.byteOffset + this._pos, length).set(array.subarray(0, length));
            this._pos += length;
            return this;
        }
        let func = (stream, item) => item.write(stream) != false;
        return this.pushArrayByFunc(array, func, maxlength);
    }
    pushArrayOfNullable(array, maxlength) {
        let func = (stream, item) => stream.pushBool(item != null) && item?.write(stream) != false;
        return this.pushArrayByFunc(array, func, maxlength);
    }
    _pushNullableString(text, charSize) {
        this.pushBool(text != null);
        if (text == null)
            return this;
        let length = text.length;
        let p = this._pos;
        this._ensureAllocation((length + 1) * charSize);
        if (charSize == 1) {
            for (let i = 0; i < length; i++) {
                this._view.setUint8(this._pos, text.charCodeAt(i));
                this._pos++;
            }
            this._view.setUint8(this._pos, 0);
        }
        else {
            for (let i = 0; i < length; i++) {
                this._view.setUint16(this._pos, text.charCodeAt(i));
                this._pos += 2;
            }
            this._view.setUint16(this._pos, 0);
        }
        this._pos += charSize;
        return this;
    }
    pushAnsi(text) { return this._pushNullableString(text, 1); }
    pushUnicode(text) { return this._pushNullableString(text, 2); }
}
exports.ByteStreamW = ByteStreamW;
class ByteStreamR_ {
    _wstream;
    _view;
    _pos = 0;
    isThrowable = true;
    constructor(data) { this._view = (data instanceof ArrayBuffer) ? new DataView(data) : data; }
    UpdateFrom(stream) {
        console.assert(stream != null);
        if (stream != this._wstream)
            if (!this._wstream)
                this._wstream = stream;
            else
                throw ("Stream is not same as before!");
        this._view = stream.data;
    }
    __readNumber(bytes, isInteger, isSigned = true) {
        let pos = this._pos;
        let view = this._view;
        if (pos + bytes > view.byteLength)
            if (this.isThrowable) {
                console.trace();
                throw ("Not enough stream size for reading a value");
            }
            else
                return null;
        let value = function () {
            if (isInteger) {
                if (isSigned) {
                    switch (bytes) {
                        case 1: return view.getInt8(pos);
                        case 2: return view.getInt16(pos);
                        case 3: return view.getUint16(pos) + (view.getInt8(pos + 2) << 16);
                        case 4: return view.getInt32(pos);
                        case 6: return view.getUint32(pos) + view.getInt16(pos + 4) * 0x100000000;
                        case 8: return view.getUint32(pos) + view.getInt32(pos + 4) * 0x100000000;
                    }
                }
                else {
                    switch (bytes) {
                        case 1: return view.getUint8(pos);
                        case 2: return view.getUint16(pos);
                        case 3: return view.getUint16(pos) | (view.getUint8(pos + 2) << 16);
                        case 4: return view.getUint32(pos);
                        case 6: return view.getUint32(pos) + view.getUint16(pos + 4) * 0x100000000;
                        case 8: return view.getUint32(pos) + view.getUint32(pos + 4) * 0x100000000;
                    }
                }
            }
            else
                switch (bytes) {
                    case 4: return view.getFloat32(pos);
                    case 8: return view.getFloat64(pos);
                }
            return null;
        }();
        if (value == null)
            if (this.isThrowable)
                throw ("Wrong byte length: " + bytes);
            else
                return null;
        this._pos += bytes;
        return value;
    }
    _readNumber(bytes, isInteger, isSigned = true) { return this.__readNumber(bytes, isInteger, isSigned); }
    noThrow() { if (!this.isThrowable)
        return this; let other = new ByteStreamR_(this._view); other._pos = this._pos; other.isThrowable = false; return other; }
    readInt8() { return this._readNumber(1, true); }
    readInt16() { return this._readNumber(2, true); }
    readInt24() { return this._readNumber(3, true); }
    readInt32() { return this._readNumber(4, true); }
    readInt48() { return this._readNumber(6, true); }
    readInt64() { return this._readNumber(8, true); }
    readUint8() { return this._readNumber(1, true, false); }
    readUint16() { return this._readNumber(2, true, false); }
    readUint24() { return this._readNumber(3, true, false); }
    readUint32() { return this._readNumber(4, true, false); }
    readUint48() { return this._readNumber(6, true, false); }
    readUint64() { return this._readNumber(8, true, false); }
    readFloat() { return this._readNumber(4, false); }
    readDouble() { return this._readNumber(8, false); }
    readBool() { let res = this.readInt8(); return (res != null ? res != 0 : null); }
    readNumber(type) { return this._getReadFuncForNumeric(type)(this); }
    readDate() { return new Date(this.readInt64() ?? 0); }
    toType(value) { return value; }
    _getReadFuncForNumeric(type) {
        let [isNullable, numType] = (type instanceof Nullable) ? [true, type.value] : [false, type];
        let typeInfo = getNumericTypeInfo(numType);
        if (!typeInfo)
            throw ("Wrong type: " + type);
        return ((stream) => { if (!isNullable || stream.readBool())
            return stream.__readNumber(typeInfo.size, typeInfo.integer, typeInfo.signed); return null; });
    }
    readNullable(reader) { return this.readBool() ? reader.read(this) : null; }
    readArray(arg) {
        if (typeof arg == "string" || arg instanceof Nullable)
            return this._readArrayOfNumeric(arg);
        if (0)
            return [arg.read(this)];
        if (arg instanceof Function)
            if (arg.hasOwnProperty("read"))
                return this._readArrayByReader(arg);
            else
                return this._readArrayByFunc(arg);
        else if ("read" in arg)
            return this._readArrayByReader(arg);
        throw ("Wrong argument in readArray");
    }
    _readArrayByFunc(func) {
        let size = this.readUint32();
        if (size == null)
            return null;
        let array = new Array(size);
        for (let i = 0; i < size; i++)
            array[i] = func(this);
        return array;
    }
    _readArrayOfNumeric(type) {
        if (type == "int8" || type == "uint8") {
            let arrayClass = type == "int8" ? Int8Array : Uint8Array;
            let size = this.readUint32();
            if (size == null)
                return null;
            if (this._pos + size > this._view.byteLength)
                if (this.isThrowable)
                    throw ("Array read out of range");
                else
                    return null;
            let bufpos = this._view.byteOffset + this._pos;
            const out = new arrayClass(this._view.buffer.slice(bufpos, bufpos + size));
            this._pos += size;
            return Array.from(out);
        }
        return this._readArrayByFunc(this._getReadFuncForNumeric(type));
    }
    _readArrayByReader(reader) { return this._readArrayByFunc(reader.read); }
    _readNullableString(charSize) {
        if (!this.readBool())
            return null;
        let chars = [];
        let nullTerminated = false;
        if (charSize == 1) {
            for (; this._pos < this._view.byteLength; this._pos++) {
                let char = this._view.getUint8(this._pos);
                if (char != 0)
                    chars.push(char);
                else {
                    nullTerminated = true;
                    break;
                }
            }
        }
        else {
            for (; this._pos < this._view.byteLength; this._pos += 2) {
                let char = this._view.getUint16(this._pos);
                if (char != 0)
                    chars.push(char);
                else {
                    nullTerminated = true;
                    break;
                }
            }
        }
        if (!nullTerminated)
            throw "Can't get null-terminated string!";
        this._pos += charSize;
        return String.fromCharCode(...chars);
    }
    readAnsi() { return this._readNullableString(1); }
    readUnicode() { return this._readNullableString(2); }
}
;
class ByteStreamR extends ByteStreamR_ {
    constructor(data) { super(data); }
}
exports.ByteStreamR = ByteStreamR;
;
function Test() {
    class A {
        a;
        b;
        write(stream) { stream.pushDouble(this.a).pushDouble(this.b); }
        constructor(a, b) { this.a = a; this.b = b; }
        static read(stream) { let [a, b] = [stream.readDouble(), stream.readDouble()]; return new A(a, b); }
    }
    let stream = new ByteStreamW;
    stream.pushInt16(1000);
    stream.pushInt8(150);
    stream.pushInt24(100000);
    stream.pushInt32(90000000);
    stream.pushFloat(0.5);
    stream.pushDouble(0.05);
    stream.pushArrayNumeric([1, 2, 3, 4, 5], "int16");
    stream.pushUnicode("myString");
    stream.pushAnsi("myString");
    stream.pushArray([new A(33, 44), new A(55, 66)]);
    console.log(stream);
    let rstream = new ByteStreamR(stream.data);
    let result = [
        rstream.readInt16(),
        rstream.readInt8(),
        rstream.readInt24(),
        rstream.readInt32(),
        rstream.readFloat(),
        rstream.readDouble(),
        rstream.readArray("int16"),
        rstream.readUnicode(),
        rstream.readAnsi(),
        rstream.readArray(A.read),
    ];
    console.log(result);
}
class X {
    fff(arg) { }
}
let x = new X;
