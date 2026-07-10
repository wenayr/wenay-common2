declare class CBaseList<T> {
    data: T | undefined;
}
export declare class CListNodeAnd<T> extends CBaseList<T> implements iListNodeMini {
    get count(): number;
    private _stop;
    protected _count: number;
    private _prev;
    private _next;
    private _home;
    private _Init;
    constructor(prev?: CListNodeAnd<T>, next?: CListNodeAnd<T>, home?: CListNodeAnd<T>);
    static _valueG: number;
    static _valueG2: number;
    readonly id: number;
    valueOf(): number;
    countRef(): number;
    Prev(): CListNodeAnd<T> | undefined;
    Next(): CListNodeAnd<T> | undefined;
    isPrev(): boolean;
    isNext(): boolean;
    private _First;
    private _End;
    First(): CListNodeAnd<T> | undefined;
    End(): CListNodeAnd<T> | undefined;
    get dataFirst(): T | undefined;
    get dataEnd(): T | undefined;
    get dataPrev(): T | undefined;
    get dataNext(): T | undefined;
    get dataThis(): T | undefined;
    isForbidden(): boolean;
    isExists(): boolean;
    private static _Add;
    AddNext(a?: CListNodeAnd<T> | T): CListNodeAnd<T>;
    AddPrev(a?: CListNodeAnd<T> | T): CListNodeAnd<T>;
    AddEnd(a?: CListNodeAnd<T> | T): CListNodeAnd<T>;
    AddStart(a?: CListNodeAnd<T> | T): CListNodeAnd<T>;
    forEach(el: (item: T, e?: CListNodeAnd<T>) => void): void;
    GetArray(): T[];
    find(el: (e: CListNodeAnd<T>) => boolean): CListNodeAnd<T> | undefined;
    DeleteLink(): void;
}
export interface iListNodeMini {
    DeleteLink(): void;
}
export {};
