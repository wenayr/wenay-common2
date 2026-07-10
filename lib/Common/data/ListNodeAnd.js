"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CListNodeAnd = void 0;
class CBaseList {
    data;
}
class CListNodeAnd extends CBaseList {
    get count() {
        return this._home?._count ?? -1;
    }
    _stop = false;
    _count = 0;
    _prev = this;
    _next = this;
    _home;
    _Init(prev, next, home) {
        this._prev = prev;
        this._next = next;
        prev._next = next._prev = this;
        this._home = home;
        this.countRef();
        return this;
    }
    constructor(prev, next, home) {
        super();
        CListNodeAnd._valueG++;
        CListNodeAnd._valueG2++;
        this.id = CListNodeAnd._valueG;
        if (prev && next && home) {
            this._Init(prev, next, home);
        }
        else {
            this._stop = true;
            this._home = this;
        }
    }
    ;
    static _valueG = 0;
    static _valueG2 = 0;
    id = CListNodeAnd._valueG;
    valueOf() { return this.id; }
    countRef() {
        let count = 0;
        for (let i = this.First(); i; i = i.Next()) {
            count++;
        }
        if (this._home)
            this._home._count = count;
        return count;
    }
    Prev() { return !this._prev._stop ? this._prev : undefined; }
    Next() { return !this._next._stop ? this._next : undefined; }
    isPrev() { return !this._prev._stop; }
    isNext() { return !this._next._stop; }
    _First() { let buf = this; while (!buf._stop) {
        buf = buf._prev;
    } return buf; }
    _End() { let buf = this; while (!buf._stop) {
        buf = buf._next;
    } return buf; }
    First() { return this._First().Next(); }
    End() { return this._End().Prev(); }
    get dataFirst() { return this._First().dataNext; }
    get dataEnd() { return this._End().dataPrev; }
    get dataPrev() { return this.Prev()?.data; }
    get dataNext() { return this.Next()?.data; }
    get dataThis() { return this._stop ? undefined : this.data; }
    isForbidden() { return this._stop; }
    isExists() { return this.isForbidden() || this._prev._stop || this._next._stop; }
    static _Add(prev, next, home, a) { let buf = new CListNodeAnd(prev, next, home); buf.data = a; return buf; }
    AddNext(a) { return a instanceof CListNodeAnd ? a._Init(this, this._next, this) : arguments.length ? CListNodeAnd._Add(this, this._next, this._home, a) : new CListNodeAnd(this, this._next); }
    AddPrev(a) { return a instanceof CListNodeAnd ? a._Init(this._prev, this, this) : arguments.length ? CListNodeAnd._Add(this._prev, this, this._home, a) : new CListNodeAnd(this._prev, this); }
    AddEnd(a) { return this._stop ? this.AddPrev(a) : this._End().AddNext(a); }
    AddStart(a) { return this._stop ? this.AddNext(a) : this._First().AddPrev(a); }
    forEach(el) {
        for (let buf = this.First(); buf && !buf.isForbidden();) {
            let t = buf.Next();
            el(buf.data, buf);
            buf = t;
        }
    }
    GetArray() { let a = []; this.forEach(e => a.push(e)); return a; }
    find(el) { let buf = this.First(); for (; buf; buf = buf.Next()) {
        if (el(buf))
            return buf;
    } return undefined; }
    DeleteLink() { this._prev._next = this._next; this._next._prev = this._prev; this._prev = this._next = this; this._stop = true; this._home?.countRef(); CListNodeAnd._valueG2--; this._home = undefined; }
}
exports.CListNodeAnd = CListNodeAnd;
