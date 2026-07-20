// =============================================================================
// LEGACY — circular intrusive node list. Superseded by CList (data/List.ts).
// Kept for backward compatibility; prefer CList for new code.
// =============================================================================

class CBaseList<T>{
    data:T|undefined;
}

/** @deprecated legacy circular intrusive list — use CList from data/List.ts */
export class CListNodeAnd<T>  extends  CBaseList<T> implements iListNodeMini{
    get count(): number {
        return this._home?._count??-1;
    }

//Just nodes with control first and last nodes - this node is not accessible via Prev() Next() method it will return undefined, system is cyclic with hard separator so access via methods will not be cyclic) but this is JavaScript
    //since system is cyclic it can never contain undefined, if it got there, private member access was violated
    //data;

    private  _stop:boolean=false;//warning - changes forbidden outside class and inside class only during initialization

    protected _count:number =0
    private _prev:CListNodeAnd<T>=this;            //must be private for cycling
    private _next:CListNodeAnd<T>=this;            //must be private for cycling
    private _home:CListNodeAnd<T>|undefined;            //central element
    private _Init(prev:CListNodeAnd<T>,next:CListNodeAnd<T>, home:CListNodeAnd<T>)        {
        this._prev=prev;
        this._next=next;
        prev._next=next._prev=this;
        this._home=home;
        this.countRef(); // technically multiple chains can be initialized at once, so I recalculate count
        return this;
    } //must be private for cycling
    //works only if two values given, with empty initialization creates new list i.e. control node which has no working nodes yet and ignores data
    //can only move working nodes
    constructor(prev?:CListNodeAnd<T>,next?:CListNodeAnd<T>, home?:CListNodeAnd<T>)  {
        super();
//        console.log(CListNode._valueG);
        CListNodeAnd._valueG++;
        CListNodeAnd._valueG2++;
        this.id= CListNodeAnd._valueG;
        if (prev && next && home) {
            this._Init(prev,next,home);}
        else {
            this._stop=true;
            this._home=this;
        }
        //if ((this._home?.count??0) >50) console.trace("list node",this._home?.count )
    };
    static _valueG:number=0;
    static _valueG2:number=0;
    readonly id:number=CListNodeAnd._valueG;
    override valueOf()               {return this.id;}
    countRef():number       {
        let count=0;
        for (let i=this.First(); i; i=i.Next()) {count++}
        if (this._home) this._home._count=count;
        return count;
    }

    Prev():CListNodeAnd<T>|undefined             {return !this._prev._stop?      this._prev: undefined;}
    Next():CListNodeAnd<T>|undefined             {return !this._next._stop?      this._next: undefined;}
    isPrev():boolean        {return !this._prev._stop;}
    isNext():boolean        {return !this._next._stop;}

    //if cycling occurred - then private methods were called, most likely flags _first and _end were reset
    private _First():CListNodeAnd<T>           {let buf:CListNodeAnd<T>=this; while (!buf._stop) {buf=buf._prev;} return buf;}//private
    private _End():CListNodeAnd<T>             {let buf:CListNodeAnd<T>=this; while (!buf._stop) {buf=buf._next;} return buf;}//private

    First():CListNodeAnd<T>|undefined            {return this._First().Next();}
    End():CListNodeAnd<T>|undefined              {return this._End().Prev();}

    get dataFirst():T|undefined             {return this._First().dataNext;}
    get dataEnd():T|undefined               {return this._End().dataPrev;}
    get dataPrev():T|undefined              {return this.Prev()?.data;}
    get dataNext():T|undefined              {return this.Next()?.data;}
    get dataThis():T|undefined              {return this._stop?          undefined: this.data;}

    isForbidden():boolean   {return this._stop;}
    isExists():boolean      {return this.isForbidden() || this._prev._stop || this._next._stop;}
    //need to write for taking all list elements, like if we add whole list into this list, so it happens
    private static _Add<T>(prev:CListNodeAnd<T>,next:CListNodeAnd<T>,home:CListNodeAnd<T>,a:T):CListNodeAnd<T> {let buf=new CListNodeAnd<T>(prev,next, home); buf.data=a; return buf;}
    AddNext(a?:CListNodeAnd<T>|T):CListNodeAnd<T>   {return a instanceof CListNodeAnd? a._Init(this,this._next, this): arguments.length ? CListNodeAnd._Add<T>(this,this._next,this._home!,a as T) : new CListNodeAnd<T>(this,this._next);}
    AddPrev(a?:CListNodeAnd<T>|T):CListNodeAnd<T>   {return a instanceof CListNodeAnd? a._Init(this._prev,this, this): arguments.length ? CListNodeAnd._Add<T>(this._prev,this,this._home!,a as T) : new CListNodeAnd<T>(this._prev,this);}
    AddEnd(a?:CListNodeAnd<T>|T):CListNodeAnd<T>    {return this._stop? this.AddPrev(a): this._End().  AddNext(a);}
    AddStart(a?:CListNodeAnd<T>|T):CListNodeAnd<T>  {return this._stop? this.AddNext(a): this._First().AddPrev(a);}
    forEach(el:(item:T,e?:CListNodeAnd<T>)=>void)                         {
        for (let buf=this.First(); buf && !buf.isForbidden();) { let t=buf.Next(); el(buf.data as T,buf); buf=t;}
    }
    GetArray():T[] {let a:T[]=[]; this.forEach(e=>a.push(e)); return a}
    find(el:(e:CListNodeAnd<T>)=>boolean):CListNodeAnd<T>|undefined       {let buf=this.First(); for (; buf; buf=buf.Next()) { if (el(buf)) return buf;} return undefined;}
    DeleteLink()             {this._prev._next=this._next; this._next._prev=this._prev; this._prev=this._next=this; this._stop=true; this._home?.countRef(); CListNodeAnd._valueG2--; this._home=undefined; }//console.log("DeleteLink")}
    //adding batch of nodes, transfers only working nodes, can reference control node and then transfer starts from first working node
    // AddNextArrayList(start:CListNode<T>,finish:CListNode<T>|undefined=undefined) {// method not implemented
    //     if (finish===undefined) finish=this.End();
    //     if (start instanceof CListNode && finish instanceof CListNode) {
    //         if (start._stop)  start = start._next;
    //         if (finish._stop) finish=finish._prev;
    //         if (this._prev) {this._prev._next=this._next;} if (this._next) {this._prev._next=this._next;} this._prev=undefined; this._next=undefined;
    //         start ._prev._next=finish._next;//cut from previous list
    //         finish._next._prev=start ._prev;//cut from previous list
    //         finish._next=this._next;
    //         start ._prev=this;
    //         this._next._prev=finish;
    //         this._next=start;
    //     }
    // }
}


export interface iListNodeMini{
    DeleteLink():void;
}

