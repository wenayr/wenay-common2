//import {NullLiteral} from "typescript";

import {const_Date} from "./BaseTypes";

function createCopyOfBuffer(src : Readonly<ArrayBuffer>, length :number= src.byteLength)  {
	let dst = new ArrayBuffer(length);
	new Uint8Array(dst).set(new Uint8Array(src as ArrayBuffer));
	return dst;
}



export type NumericTypes= "int8"|"int16"|"int24"|"int32"|"int48"|"int64"|"float"|"double"|"uint8"|"uint16"|"uint24"|"uint32"|"uint48"|"uint64";

export class Nullable<T extends NumericTypes> { value: T;  constructor(type :T) { this.value= type; } }

export function nullable(type :NumericTypes) { return new Nullable(type); }


// let [size, isFloat] = type=="int8" ? [1] : type=="int16" ? [2] : type=="int24" ? [3] :
// 	type=="int32" ? [4] : type=="int64" ? [8] : type=="float" ? [4,true] : type=="double" ? [8,true] : null;
// if (size==null) throw("Wrong type: "+type);

function __getNumericTypeInfo(type :NumericTypes) : [number,boolean?,boolean?]|null {
	switch(type) {
		case "int8": return[1];  case "uint8": return[1,false];  case "int16": return[2]; case "uint16": return[2,false];
		case "int24": return[3];  case "uint24": return[3,false];  case "int32": return[4];  case "uint32": return[4,false];
		case "int48": return[6];  case "uint48": return[6,false];  case "int64": return[8];  case "uint64": return[8,false];
		case "float": return[4,true,false];  case "double": return[8,true,false];
		default: throw "wrong type: "+type; //return null;
	}
};

function getNumericTypeInfo(type :NumericTypes)  : { size: number, signed: boolean, integer :boolean }|null
{
	let [size, signed=true, integer=true] = __getNumericTypeInfo(type) ?? [0];
	if (!size) return null;
	return { size, signed, integer };
}




export type WritableToBytes = { write(stream :ByteStreamW) :boolean|void; };


//--------------------

export class ByteStreamW
{
	//protected _buffer : ArrayBuffer;
	protected _view : DataView = new DataView(new ArrayBuffer(0));
	protected _pos : number = 0;
	protected _isThrowable = true;
	protected _buffer() { return this._view?.buffer; }

	protected resize(size :number) {
		// if (!this._buffer()) throw "Buffer is not created";
		let buf= createCopyOfBuffer(this._buffer() as Readonly<ArrayBuffer>, size);  this._view= new DataView(buf); }

	constructor(view? :DataView) {
		if (view) {
			this._view = view;
		} else {
			this.resize(0);
		}
	}

	get length() { return this._pos; }
	//get buffer() : Readonly<ArrayBuffer> { return this._buffer; }

	get data() : Readonly<DataView> { return new DataView(this._buffer(), 0, this._pos); }

	noThrow() : ByteStreamW { let other= new ByteStreamW(this._view);  other._pos= this._pos;  other._isThrowable= false;  return other; }
	// Обеспечить наличие свободных байт
	private _ensureAllocation(bytes :number) {
		let minSize= this._pos + bytes;
		if (minSize > this._view.byteLength)
			for(let extraSize= Math.max(minSize*0.5, 32);  extraSize>=0;  extraSize/=2) {
				try { this.resize(minSize + extraSize);  break; } //this.resize(Math.max((this._pos + bytes) * 1.5, 32));
				catch(e) { if (extraSize<1) throw(e); }
			}
	}

	private _setInt8(pos :number, value :number) { if ((value & 1<<7)!=0) this._view.setInt8(pos, value); else this._view.setUint8(pos, value); }
	private _setInt16(pos :number, value :number) { if ((value & 1<<15)!=0) this._view.setInt16(pos, value); else this._view.setUint16(pos, value); }
	private _setInt32(pos :number, value :number) { if ((value & 1<<31)!=0) this._view.setInt32(pos, value); else this._view.setUint32(pos, value); }

	protected _push(value :number, bytes :number, isInteger :boolean)  {
		let pos= this._pos;
		this._ensureAllocation(bytes);
		let view= this._view;
		if (isNaN(value)) throw "Failed to save NaN";
		if (isInteger && !Number.isInteger(value)) throw "Failed to save value "+value+" as integer";
		if (isInteger)
			switch(bytes) {
				case 1: this._setInt8(pos, value);  break;
				case 2: this._setInt16(pos, value); break;
				case 3: this._setInt16(pos, value); this._setInt8(pos+2, value>>16);  break; //console.log("! ",view.getInt16(pos)," ",view.getInt8(pos+2));
				case 4: this._setInt32(pos, value);  break;
				case 6: this._setInt32(pos, value);  this._setInt16(pos+4, value/0x10000000);  break;
				case 8: this._setInt32(pos, value);  this._setInt32(pos+4, value/0x10000000);  break;
				default: throw("Wrong byte length: "+bytes);
			}
		else
			switch(bytes) {
				case 4: view.setFloat32(pos, value); break;
				case 8: view.setFloat64(pos, value); break;
				default: throw("Wrong byte length: "+bytes);
			}
		this._pos += bytes;
		return this;
	}

	pushInt8(value :number) { return this._push(value, 1, true); }
	pushInt16(value :number) { return this._push(value, 2, true); }
	pushInt24(value :number) { return this._push(value, 3, true); }
	pushInt32(value :number) { return this._push(value, 4, true); }
	pushInt48(value :number) { return this._push(value, 6, true); }
	pushInt64(value :number) { return this._push(value, 8, true); }
	pushFloat(value :number) { return this._push(value, 4, false); }
	pushDouble(value :number) { return this._push(value, 8, false); }
	pushBool(value :boolean)   { return this.pushInt8(value==true ? 1 : 0); }

	pushDate(value :const_Date) { return this.pushInt64(value.valueOf()); }

	private _checkResult(result : boolean|void,  msg :()=>string) { if (result==false && this._isThrowable) throw("Failed to write "+msg);  return result!=false; }

	push(obj :WritableToBytes)  { let ok= obj.write(this);  return this._checkResult( ok, ()=>"object" ) ? this : null; }

	pushNullable(obj :WritableToBytes|null)  { let ok= this.pushBool(obj!=null) ? obj?.write(this) : false;  return this._checkResult(ok, ()=>"object") ? this : null; }

	pushNumber(value :number,  type: NumericTypes|Nullable<NumericTypes>) { return this._getWriteFuncForNumeric(type)(this, value); }

	pushNumbers(values : readonly number[],  type: NumericTypes|Nullable<NumericTypes>) { for(let value of values) if (!this.pushNumber(value, type)) return null;  return this; }

	pushArrayByFunc<T>(array :Iterable<T>,  func : (stream :ByteStreamW, item :T)=>boolean|void,  maxlength? :number) {
		let oldpos= this._pos;
		this.pushInt32(0);
		let i=0;
		for (let value of array) {
			if (func(this, value)==false) if (this._isThrowable) throw("Failed to write array item №"+i); else return null;
			i++;  if (i===maxlength) break;
		} //this.pushNumbers([], "int32");
		this._view.setUint32(oldpos, i);
		return this;
	}

	protected _getWriteFuncForNumeric(type: NumericTypes|Nullable<NumericTypes>) {
		let isNullable= false;
		if (type instanceof Nullable) { type= type.value;  isNullable=true; }

		let typeInfo= getNumericTypeInfo(type)!; // ?? (()=>{throw("Wrong type: "+type)})
		if (!typeInfo) throw("Wrong type: "+type);
		return (stream :ByteStreamW, value :number)=> { return (isNullable ? stream.pushBool(value!=null) : stream)?._push(value, typeInfo.size, typeInfo.integer) !=null; }
	}

	pushArrayNumeric(array :Iterable<number>,  type : NumericTypes|Nullable<NumericTypes>,  maxlength? :number)
	{
		return this.pushArrayByFunc(array, this._getWriteFuncForNumeric(type), maxlength);
	}

	pushArray<T extends WritableToBytes> (array :Iterable<T>|Int8Array|Uint8Array, maxlength? :number)
	{
		if (array instanceof Int8Array || array instanceof Uint8Array) {
			let length = Math.min(array.length, maxlength ?? array.length);
			this._ensureAllocation(length+4);
			this.pushInt32(length);
			let arrayClass= (array instanceof Int8Array) ? Int8Array : Uint8Array;
			if (length != array.length) {
				// @ts-ignore
				array = new arrayClass(array.buffer, 0, length);
			}
			// @ts-ignore
			new arrayClass(this._buffer()).set(array, this._pos);
			this._pos += length;
			return this;
		}
		let func = (stream :ByteStreamW, item :T)=> item.write(stream)!=false;
		return this.pushArrayByFunc(array, func, maxlength);
	}


	pushArrayOfNullable<T extends WritableToBytes|null> (array :Iterable<T>, maxlength? :number)  {
		let func = (stream :ByteStreamW, item :T)=> stream.pushBool(item!=null) && item?.write(stream)!=false;
		return this.pushArrayByFunc(array, func, maxlength);
	}

	private _pushNullableString(text :string|null, charSize :1|2) {
		this.pushBool(text!=null);
		if (text==null) return this;
		let length= text.length;
		let p= this._pos;
		this._ensureAllocation((length+1)*charSize);
		if (charSize==1) {
			for (let i=0; i<length; i++) { this._view.setUint8(this._pos, text.charCodeAt(i));  this._pos++; }
			this._view.setUint8(this._pos, 0);
		} else {
			for (let i=0; i<length; i++) { this._view.setUint16(this._pos, text.charCodeAt(i));  this._pos+=2; }
			this._view.setUint16(this._pos, 0);
		}
		this._pos+=charSize;  //console.log("CharCodes: ",this._buffer().slice(p, p+length*charSize));
		return this;
	}

	pushAnsi(text :string|null) { return this._pushNullableString(text, 1); }

	pushUnicode(text :string|null) { return this._pushNullableString(text, 2); }
}


//type ReaderFromBytes<T extends object|number|string|boolean> = { read(stream : ByteStreamR) : T; }
//type ReaderFromBytes<T extends NonNullable<any>> = { read(stream : ByteStreamR) : T; }

type ReaderFromBytes<T> = { read(stream : ByteStreamR) : T; }


//type NullableNumericTypes= Nullable<NumericTypes>

//let a = new Nullable();

//========================

class ByteStreamR_<throwable extends boolean>
{
	//_buffer: ArrayBuffer;
	protected _wstream? : Readonly<ByteStreamW>;
	protected _view: Readonly<DataView>;
	protected _pos: number = 0;
	private isThrowable : throwable = true as throwable;

	constructor(data : Readonly<ArrayBuffer|DataView>) { this._view = (data instanceof ArrayBuffer) ? new DataView(data) : data as DataView; }

	UpdateFrom(stream : Readonly<ByteStreamW>) {
		console.assert(stream!=null);
		if (stream!=this._wstream)
			if (!this._wstream) this._wstream= stream; else throw("Stream is not same as before!");
		this._view= stream.data;
	}

	private __readNumber(bytes :number, isInteger :boolean, isSigned=true) : number|null {
		let pos= this._pos;
		let view= this._view;
		if (pos + bytes > view.byteLength)
			if (this.isThrowable) { console.trace();  throw("Not enough stream size for reading a value"); }
			else return null;
		let value= function() {
			if (isInteger) {
				if (isSigned) {
					switch (bytes) {
						case 1: return view.getInt8(pos);
						case 2: return view.getInt16(pos);
						case 3: return view.getInt16(pos) | (view.getInt8(pos + 2) << 16);
						case 4: return view.getInt32(pos);
						case 6: return view.getInt32(pos) | view.getInt16(pos + 4) * 0x10000000;
						case 8: return view.getInt32(pos) | view.getInt32(pos + 4) * 0x10000000;
					}
				}
				else {
					switch (bytes) {
						case 1: return view.getUint8(pos);
						case 2: return view.getUint16(pos);
						case 3: return view.getUint16(pos) | (view.getUint8(pos + 2) << 16);
						case 4: return view.getUint32(pos);
						case 6: return view.getUint32(pos) | view.getUint16(pos + 4) * 0x10000000;
						case 8: return view.getUint32(pos) | view.getUint32(pos + 4) * 0x10000000;
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
		if (value==null)
			if (this.isThrowable) throw("Wrong byte length: " + bytes);
			else return null;
		this._pos+= bytes;
		return value;
	}

	_readNumber(bytes :number, isInteger :boolean, isSigned=true) { return this.__readNumber(bytes, isInteger, isSigned) as (throwable extends true ? number : number|null); }

	noThrow() : ByteStreamR_<false> { if (!this.isThrowable) return this as unknown as ByteStreamR_<false>;  let other= new ByteStreamR_<false>(this._view);  other._pos= this._pos;  other.isThrowable= false;  return other; }

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
	readBool()   { let res= this.readInt8();  return (res!=null ? res!=0 : null) as (throwable extends true ? boolean : boolean|null); }

	readNumber(type :NumericTypes|Nullable<NumericTypes>)  { return this._getReadFuncForNumeric(type)(this); }

	readDate() { return new Date(this.readInt64() ?? 0); }

	toType<T>(value :T) { return value as (throwable extends true ? T : T|null); }

	protected _getReadFuncForNumeric<T extends NumericTypes|Nullable<NumericTypes>> (type :T) { //: (stream :ByteStreamR_<throwable>)=>((T extends NumericTypes) && (throwable extends true) ? number : number|null) {  //(stream :ByteStreamR)=>number
		let [isNullable, numType]= (type instanceof Nullable) ? [true, type.value] : [false, type];
		//if (type instanceof Nullable) { isNullable=true;  type= type.value; }
		let typeInfo= getNumericTypeInfo(numType)!;
		if (!typeInfo) throw("Wrong type: "+type);  //(T extends NumericTypes) &&
		type tRes= throwable extends true ? number : T extends NumericTypes ? number : number|null;  //(stream :ByteStreamR)=>number
		return ((stream :ByteStreamR_<throwable>)=>{ if (!isNullable || stream.readBool()) return stream.__readNumber(typeInfo.size, typeInfo.integer, typeInfo.signed);  return null; }
		) as (stream :ByteStreamR_<throwable>)=>tRes;
	}

	readNullable<T>(reader :ReaderFromBytes<NonNullable<T>>) { return this.readBool() ? reader.read(this as unknown as ByteStreamR) : null; }//  if (this.isThrowable) return f();  try() { return f() } catch(...) { } }

	readArray<T>(func: (stream :ByteStreamR)=>NonNullable<T>) : T[];

	readArray<T extends NumericTypes|Nullable<NumericTypes>>(type :T)  : T extends NumericTypes ? number[] : (number|null)[]; //NumericTypes|(NumericTypes+"?")) //"int8"|"int16"|"int24"|"int32"|"int64"|"float"|"double");

	readArray<T>(reader :ReaderFromBytes<NonNullable<T>>) : T[];

	readArray<T>(arg :any) // : (stream :ByteStreamR)=>NonNullable<T> | (NumericTypes|Nullable<NumericTypes>) | ReaderFromBytes<NonNullable<T>>)
	{
		if (typeof arg=="string" || arg instanceof Nullable) return this._readArrayOfNumeric(arg as NumericTypes);
		if (0) return [(arg as ReaderFromBytes<T>).read(this as unknown as ByteStreamR)]; // Проверка наличия метода в типе
		if (arg instanceof Function)
			if (arg.hasOwnProperty("read")) return this._readArrayByReader(arg);
			else return this._readArrayByFunc(arg);
		else if ("read" in arg) return this._readArrayByReader(arg);  //if (typeof arg=="function")

		throw("Wrong argument in readArray");
		//if (typeof arg=="function") return this._readArrayByFunc(arg);
	}

	protected _readArrayByFunc<T>(func: (stream :ByteStreamR)=>T) : T[]|null {
		let size= this.readUint32();  if (size==null) return null;
		let array= new Array(size);  //let ddd= this;  func(this);
		for(let i=0; i<size; i++)
            //@ts-ignore
            array[i]= func(this);
		return array;
	}
    //@ts-ignore
	protected _readArrayOfNumeric(type : NumericTypes)  {
		if (type=="int8" || type=="uint8") {
			let arrayClass= type=="int8" ? Int8Array : Uint8Array;
			let size= this.readUint32();  if (size==null) return null;
			let bufpos= this._view.byteOffset + this._pos;
			// @ts-ignore
			const out = new arrayClass(this._view.buffer.slice(bufpos, bufpos+size!));
			this._pos += size;
			return Array.from(out);
		}
        //@ts-ignore
		return this._readArrayByFunc(this._getReadFuncForNumeric(type));
	}

	protected _readArrayByReader<T>(reader :ReaderFromBytes<T>) { return this._readArrayByFunc(reader.read); }
	// 	let func= (stream)=>reader.read(stream); //{ let exists= stream.readInt8();  return exists ? reader.read(stream) : null; }
	// 	return this._readArrayByFunc(func);
	// }

	private _readNullableString(charSize :1|2) : string|null
	{
		if (! this.readBool()) return null;
		let chars :number[] = [];  //let maxlength= this._view.byteLength - this._pos;
		let nullTerminated= false;
		if (charSize==1) {
			for(;  this._pos < this._view.byteLength;  this._pos++) { //for (let i=0; i<maxlength; i++) {
				let char= this._view.getUint8(this._pos); //this._pos++;
				if (char!=0) chars.push(char); else { nullTerminated=true;  break; }
			}
		} else {
			for(;  this._pos < this._view.byteLength;  this._pos+=2) {
				let char= this._view.getUint16(this._pos); //this._pos++;
				if (char!=0) chars.push(char); else { nullTerminated=true;  break; }
			}
		}
		if (! nullTerminated) throw "Can't get null-terminated string!"; //return undefined;
		this._pos+= charSize;
		//console.log(chars);
		return String.fromCharCode(...chars);
	}

	readAnsi() : string|null { return this._readNullableString(1); }

	readUnicode() : string|null { return this._readNullableString(2); }
};


export class ByteStreamR extends ByteStreamR_<true> {
	constructor(data : Readonly<ArrayBuffer|DataView>) { super(data); }
};



function Test()
{

	class A {
		a : number;
		b : number;
		write(stream :ByteStreamW) { stream.pushDouble(this.a).pushDouble(this.b); }
		constructor(a :number, b :number) { this.a= a;  this.b= b; }

		static read(stream :ByteStreamR) { let [a, b]= [stream.readDouble(), stream.readDouble()];  return new A(a,b); }
	}

	let stream= new ByteStreamW;
	stream.pushInt16(1000);
	stream.pushInt8(150);
	stream.pushInt24(100000);
	stream.pushInt32(90000000);
	stream.pushFloat(0.5);
	stream.pushDouble(0.05);
	stream.pushArrayNumeric([1,2,3,4,5], "int16");
	stream.pushUnicode("myString");
	stream.pushAnsi("myString");
	stream.pushArray([new A(33, 44), new A(55,66)]);

	console.log(stream);

	let rstream= new ByteStreamR(stream.data);
	let result= [
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
		//rstream.readFloat()
	];
	console.log(result);
	//rstream.readArray(nullable("int16"));
}


//Test();
class X<T>
{
	fff(arg : T extends number ? number : never)  { }
}

let x : X<string> = new X;

//let z = x.fff();

//console.log(new ArrayBuffer(0xFFFFFFFF));
