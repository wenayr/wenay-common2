import {CListNodeAnd} from "../data/ListNodeAnd";
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

//callback версия 2.0 по массивам
export class CObjectEventsArr<T extends object>{
    private data :tListEvent[] = []

    private setup(link:tListEvent) {
        const data = link
        data.del = ()=> {
            for (let i = 0; i < this.data.length; i++) {
                if (this.data[i]==data) {
                    this.data.splice(i,1)
                    data.OnDel?.();
                    return;
                }
            }
            console.error("элемент уже был удален")
            console.trace()
            // OnDel уже сработал при реальном удалении выше; на ветке «не найдено» не дублируем его
            console.log(this.count());
        }
    }
    AddStart(data:tListEvent)               {this.data.unshift(data); this.setup(this.data[0])}
    /** @deprecated Используйте `add(item, {at: 'end'})`. */
    AddEnd(data:tListEvent)                 {this.setup(this.data[this.data.push(data)-1])}
    /** @deprecated Используйте `add(item)`. */
    Add(data:tListEvent)                    {this.setup(this.data[this.data.push(data)-1])}
    /** Добавить обработчик (по умолчанию в конец). `at: 'start'` — в начало (unshift/prepend). */
    add(data:tListEvent, opts:{at?:'start'|'end'} = {}) {opts.at == 'start' ? this.AddStart(data) : this.AddEnd(data)}
    /** @deprecated Используйте `emit(data?)`. */
    OnEvent(data?:any)                      {[...this.data].forEach((e)=>{e.func?.(data); if (e.func2) {e.func2(data); e.del?.();}})}
    /** Вызвать все обработчики (идиома `emit`). */
    emit(data?:any)                         {this.OnEvent(data)}

    // OnSpecEvent<T extends object>(f:(e:T)=>void)           {this.data.forEach((e)=>{let l=e.func?.() as T; if (l) {f(l);}  e.func2?.();})}
    OnSpecEvent(f:(e:T)=>void)              {[...this.data].forEach((e)=>{const l= e.func?.() as unknown as (T|undefined); l&&f(l); if (e.func2) {e.func2(); e.del?.();}})} // l&&f(l);  if (l) {f(l);}
    /** @deprecated Используйте `clear()`. */
    Clean()                                 {
        const a = [...this.data];
        for (let i = a.length - 1; i >= 0; i--) {
            a[i].del?.();
        }
    }
    /** Снести все обработчики (идиома `clear`, полный teardown через del()). */
    clear()                                 {this.Clean()}
    count()                                 {return this.data.length}
    get length()                            {return this.count()}
    /** Число обработчиков (идиома `size`). */
    get size()                              {return this.count()}
}


export class CObjectEventsList<T=unknown>{
    constructor(log=true) {
        this._log=log;
    }
    Id =0
    private _log = false
    private data = new CListNodeAnd<tListEvent<T>>()
    private setup(link:CListNodeAnd<tListEvent<T>>) {
        const buf = link;
        const data = link.data!
        let prevDel = data.del
        data.del = ()=>{
            prevDel?.()
            prevDel = undefined; // чтобы функция удаления отчищалась при срабатывании
            buf.DeleteLink();
            data.OnDel?.();
        }
        if (this._log && this.count()>20) {
            console.trace("подозрительное большое количество подписок ",this.count());
            this.log();
        }
    }

    log()                       {const er:object[]=[]; this.data.forEach(e=>er.push(e)); console.log(er);}
    AddStart(data:tListEvent)   {this.setup(this.data.AddStart(data))}
    /** @deprecated Используйте `add(item, {at: 'end'})`. */
    AddEnd(data:tListEvent)     {this.setup(this.data.AddEnd(data))}
    /** @deprecated Используйте `add(item)`. */
    Add(data:tListEvent)        {this.setup(this.data.AddEnd(data))}
    /** Добавить обработчик (по умолчанию в конец). `at: 'start'` — в начало. */
    add(data:tListEvent, opts:{at?:'start'|'end'} = {}) {opts.at == 'start' ? this.AddStart(data) : this.AddEnd(data)}
    /** @deprecated Используйте `emit(data?)`. */
    OnEvent(data?:T)            {const a:tListEvent<T>[]=[]; this.data.forEach(e=>a.push(e)); a.forEach(e=>{e.func?.(data); if (e.func2) {e.func2(data); e.del?.();}})}
    /** Вызвать все обработчики (идиома `emit`). */
    emit(data?:T)               {this.OnEvent(data)}
    OnSpecEvent<R>(f:(e?:R)=>void)  {const a:tListEvent<T>[]=[]; this.data.forEach(e=>a.push(e)); a.forEach((e)=>{const l: any=e.func?.(); if (l) {f(l as unknown as R);}  if (e.func2) {e.func2(); e.del?.();}})}
    /** @deprecated Используйте `clear()`. */
    Clean()                     {const a:tListEvent<T>[]=[]; this.data.forEach(e=>a.push(e)); for (let i = a.length - 1; i >= 0; i--) a[i].del?.()}
    /** Снести все обработчики (идиома `clear`). */
    clear()                     {this.Clean()}
    count()                     {return this.data.countRef()}
    get length()                {return this.count()}
    /** Число обработчиков (идиома `size`). */
    get size()                  {return this.count()}
}
