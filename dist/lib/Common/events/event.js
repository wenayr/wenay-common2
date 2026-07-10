"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CObjectEventsList = exports.CObjectEventsArr = void 0;
const ListNodeAnd_1 = require("../data/ListNodeAnd");
class CObjectEventsArr {
    data = [];
    setup(link) {
        const data = link;
        data.del = () => {
            for (let i = 0; i < this.data.length; i++) {
                if (this.data[i] == data) {
                    this.data.splice(i, 1);
                    data.OnDel?.();
                    return;
                }
            }
            console.error("элемент уже был удален");
            console.trace();
            console.log(this.count());
        };
    }
    AddStart(data) { this.data.unshift(data); this.setup(this.data[0]); }
    AddEnd(data) { this.setup(this.data[this.data.push(data) - 1]); }
    Add(data) { this.setup(this.data[this.data.push(data) - 1]); }
    add(data, opts = {}) { opts.at == 'start' ? this.AddStart(data) : this.AddEnd(data); }
    OnEvent(data) { [...this.data].forEach((e) => { e.func?.(data); if (e.func2) {
        e.func2(data);
        e.del?.();
    } }); }
    emit(data) { this.OnEvent(data); }
    OnSpecEvent(f) { [...this.data].forEach((e) => { const l = e.func?.(); l && f(l); if (e.func2) {
        e.func2();
        e.del?.();
    } }); }
    Clean() {
        const a = [...this.data];
        for (let i = a.length - 1; i >= 0; i--) {
            a[i].del?.();
        }
    }
    clear() { this.Clean(); }
    count() { return this.data.length; }
    get length() { return this.count(); }
    get size() { return this.count(); }
}
exports.CObjectEventsArr = CObjectEventsArr;
class CObjectEventsList {
    constructor(log = true) {
        this._log = log;
    }
    Id = 0;
    _log = false;
    data = new ListNodeAnd_1.CListNodeAnd();
    setup(link) {
        const buf = link;
        const data = link.data;
        let prevDel = data.del;
        data.del = () => {
            prevDel?.();
            prevDel = undefined;
            buf.DeleteLink();
            data.OnDel?.();
        };
        if (this._log && this.count() > 20) {
            console.trace("подозрительное большое количество подписок ", this.count());
            this.log();
        }
    }
    log() { const er = []; this.data.forEach(e => er.push(e)); console.log(er); }
    AddStart(data) { this.setup(this.data.AddStart(data)); }
    AddEnd(data) { this.setup(this.data.AddEnd(data)); }
    Add(data) { this.setup(this.data.AddEnd(data)); }
    add(data, opts = {}) { opts.at == 'start' ? this.AddStart(data) : this.AddEnd(data); }
    OnEvent(data) { const a = []; this.data.forEach(e => a.push(e)); a.forEach(e => { e.func?.(data); if (e.func2) {
        e.func2(data);
        e.del?.();
    } }); }
    emit(data) { this.OnEvent(data); }
    OnSpecEvent(f) { const a = []; this.data.forEach(e => a.push(e)); a.forEach((e) => { const l = e.func?.(); if (l) {
        f(l);
    } if (e.func2) {
        e.func2();
        e.del?.();
    } }); }
    Clean() { const a = []; this.data.forEach(e => a.push(e)); for (let i = a.length - 1; i >= 0; i--)
        a[i].del?.(); }
    clear() { this.Clean(); }
    count() { return this.data.countRef(); }
    get length() { return this.count(); }
    get size() { return this.count(); }
}
exports.CObjectEventsList = CObjectEventsList;
