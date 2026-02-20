import {TF} from "../Common/Time";
import {tSymbolInfoBase} from "./IHistoryBase";
import {const_Date} from "../Common/BaseTypes";


export type tAlertMini = Readonly<{ signal: string, alarm: string, text: string }>;
export type tAlert = Readonly<{ symbol: string[], name: string, tf: TF }> & tAlertMini;

// // Выбираем только конкретные поля, т.к. CRBaseMapAll2 - класс-помойка, дающий неограниченный доступ ко всему на чтение/запись
// export type tOnInitSymbol = ReplaceKeyType< Pick<CRBaseMapAll2,"info"|"getAddress"|"LoadHistoryForEvent"|"LoadHistoryForEventMini">, "info", tSymbolInfoBase|undefined>;
//
// export type tOnInitSymbols = Pick<CRBaseMapAll2, "getByAddress"|"addByAddress"|"getKeys"|"getValues"|"add"|"loadNames">;



//export type tOnBarIndicator = ReplaceKeyType<tOnBarIndicatorExt, "api", IndicatorOnBarAPIBase>


// let ddd : (a :tOnBarIndicator)=>void = (a :tOnBarIndicatorExt)=>{};
//
// let eee : (a :IndicatorOnBarAPIBase)=>void = (a :IndicatorOnBarAPI)=>{};

// class CSymbol {
//     readonly name: string;
//     readonly [Symbol.species] = CSymbol;
//     constructor(symbol: string) { this.name=symbol; }
// }
//
// export type tOnBarIndicatorMulti = {
//     symBars :readonly Readonly<{symbol: CSymbol, bar :CBar, index :number, allBars: IBarsExt}>[];
// }


export type tPrice = number;

export type tTick = Readonly<{ time: const_Date, price: tPrice, volume: number }>;



export type tPix = () => number;
export type tPercent = number;
export type tFont = () => string;
export type tColor = () => string;

// событие
// что нужно выполнить при событии
// func?:(data?:T)=>void,
//     что нужно выполнить при событии выполниться сразу после первого func2(){this.del()} - удалит текущее событие после выполнения, вызовет OnDel() если он есть
//     func2?:(data?:T)=>void,
//     Удаление данного события из списка из вне
//     del?:()=>void,
//     Вызывается после удаления данного события из списка
//     OnDel?:()=>void
export type tListEvent<T=any, T2=void> = {
    // что нужно выполнить при событии
    func?:(data?:T)=>T2,
    // что нужно выполнить при событии выполниться сразу после первого func2(){this.del()} - удалит текущее событие после выполнения, вызовет OnDel() если он есть
    func2?:(data?:T)=>void,
    // Удаление данного события из списка из вне
    del?:()=>void,
    // Вызывается после удаления данного события из списка
    OnDel?:()=>void
}




export interface interfaceObj<T1, T2> {
    //позиция у обьекта
    x?: T1;
    //позиция у обьекта
    y?: T1;
    //высота обьекта
    height?: T2;
    //ширина обьекта
    with?: T2;
}

export interface interfacePointBase {
    x?: tPix;//растояние по x в пикселях или формуле
    y?: tPix;//растояние по y в пикселях или формуле
    bar?: tPix;//номер бара
    time?: tPix;//время
    price?: tPix;//цена
    //
}

export interface interfacePoint extends interfacePointBase {
    SetSign?(data: interfacePointBase): void;
} //export type tPointPix={readonly x:tPix,xSet(data:tPix):void, readonly y:tPix, ySet(data :tPix) :void}
//export type tPointBarPrice={readonly bar:tPix,xSet(data:tPix):void, readonly price:tPix, ySet(data :tPix) :void}
//export type tPointTimePrice={readonly bar:tPix,xSet(data:tPix):void, readonly price:tPix, ySet(data :tPix) :void}
export type tPoint = {}

export interface interfaceFont {
    background?: tColor;
    color?: tColor;
    font?: tFont;
    size?: tPix;
    with?: tPix;
}

export interface interfaceElement<T1, T2> extends interfaceObj<T1, T2> {
    //шрифт
    readonly font?: interfaceFont;
    //шрифт при выделении
    readonly fontSelect?: interfaceFont;
}

export interface interfaceFontT<T, T2> extends interfaceElement<T, T2> {
    readonly font: interfaceFont;

    //массовая установка свойтв
    fontSet(data: interfaceFont): void

    readonly fontSelect: interfaceFont;

    //массовая установка свойтв
    fontSelectSet(data: interfaceFont): void
}

export interface interfaceTimePanel extends interfaceFontT<tPix, tPix> {
    height: tPix;
}

export interface interfacePricePanel extends interfaceFontT<tPix, tPix> {
    with: tPix;
}
