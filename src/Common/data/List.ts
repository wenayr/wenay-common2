
export type ListNode<T> = {
    readonly value :T;
    readonly [Symbol.species] : CListNode<T>;
}

// неэкспортируемый класс!
class CListNode<T> implements ListNode<T> {
    value :T;
    list : CList<T>|undefined;
    next? :CListNode<T>;
    prev? :CListNode<T>;
    [Symbol.species] = this; //CListNode<T>;

    constructor(list : CList<T>, value :T) { this.list= list; this.value=value; }
}

export type ListNodeImm<T> = ListNode<T> & {
    readonly next? :ListNodeImm<T>;
    readonly prev? :ListNodeImm<T>;
    [Symbol.species] : CListNode<T> & "Immutable";  // readonly Immutable :true;
}
//let a : ListNodeImm<number> = undefined as unknown as ListNode<number>;
//let b : ListNode<number> = undefined as unknown as ListNodeImm<number>;

//type Node<TNode extends ListNode<unknown>> = TNode extends ListNodeImm<infer T> ? ListNodeImm<T> : TNode extends ListNode<infer T> ? ListNode<T> : never;


type Node<TNode extends ListNode<unknown>> = (TNode extends ListNodeImm<unknown> ? ListNodeImm<TNode["value"]> : ListNode<TNode["value"]>);


export class CList<T, TNode extends ListNode<T> = ListNode<T>> implements Iterable<TNode> {
    protected _first? : CListNode<T>;
    protected _last? : CListNode<T>;
    protected _count = 0;
    protected _immutableList? : CList<T, ListNodeImm<T>>;

    get first() { return this._first; }
    get last() { return this._last; }
    get count() { return this._count; }
    get length() { return this._count; }

    readonly [Symbol.iterator] = this.nodes;


    constructor(values :Iterable<T> =[])  { for(let value of values) this.add(value); }// this._immutableList= this; }

    *nodes() { for(let node=this._first, next= node?.next; node!=null; node=next, next=next?.next) yield node as unknown as TNode ; }

    *values() { for(let node of this) yield node.value; }

    *reversedNodes() { for(let node=this._last, next= node?.prev; node!=null; node=next, next=next?.prev) yield node as unknown as TNode ; }

    *reversedValues() { for(let node of this.reversedNodes()) yield node.value; }

    *entries() { return this.nodes; }


    next(node :ListNode<T>)  { return this.validateNode(node) ? node.next as TNode|undefined : (()=>{throw "Wrong node list"})(); };

    prev(node :ListNode<T>)  { return this.validateNode(node) ? node.prev as TNode|undefined : (()=>{throw "Wrong node list"})(); };

    find(value :T) { for(let node of this.nodes()) if (node.value==value) return node;  return undefined; }

    findLast(value :T) { for(let node of this.reversedNodes()) if (node.value==value) return node;  return undefined; }

    private containsValue(value :T) { return this.find(value)!=undefined; }
    private containsNode(node :ListNode<T>) { return this.validateNode(node); }

    has(value :T) :boolean;
    has(node :ListNode<T>) :boolean;
    has(data :T|ListNode<T>) { return data instanceof CListNode ? this.containsNode(data) : this.containsValue(data as T); }

    toImmutable() : IListImmutable<T> { return this._immutableList ??= new CList(this.values()); }

    private _addFirst(value :T) {
        this._count=1;
        this._immutableList= undefined;
        return this._first= this._last= this.newNode(value);
    }
    addFirst(value :T) : ListNode<T> {
        if (this._first) return this.addBefore(this._first, value);
        return this._addFirst(value);
    }
    addLast(value :T) : ListNode<T> {
        if (this._last) return this.addAfter(this._last, value);
        return this._addFirst(value);
    }
    addAfter(node :ListNode<T>, value :T) : ListNode<T> {
        if (! this.validateNode(node)) throw "Wrong node list";
        let newNode = this.newNode(value);
        newNode.prev= node;
        newNode.next= node.next;
        if (node.next) node.next.prev= newNode;
        else this._last= newNode;
        node.next= newNode;
        this._count++;
        this._immutableList= undefined;  //console.log("added",value," last:",this._last?.value);
        return newNode;
    }
    addBefore(node :ListNode<T>, value :T) : ListNode<T> {
        if (! this.validateNode(node)) throw "Wrong node list";
        let newNode = this.newNode(value);
        newNode.next= node;
        newNode.prev= node.prev;
        if (node.prev) node.prev.next= newNode;
        else this._first= newNode;
        node.prev= newNode;
        this._count++;
        this._immutableList= undefined;
        return newNode;
    }

    add(value :T) { return this.addLast(value); }

    private set(node :ListNode<T>, value :T) : ListNode<T> {
        if (! this.validateNode(node)) throw "Wrong node list";
        node.value= value;
        return node;
    }

    replace(node :ListNode<T>, value :T) : ListNode<T> {
        if (! this.validateNode(node)) throw "Wrong node list";
        let newNode = this.newNode(value);
        newNode.next= node.next;
        newNode.prev= node.prev;
        node.list= undefined;
        this._immutableList= undefined;
        return newNode;
    }

    private deleteNode(node :ListNode<T>) {
        if (! this.validateNode(node)) throw "Wrong node list";
        if (node.prev) node.prev.next= node.next;
        if (node.next) node.next.prev= node.prev;
        if (node==this._first) this._first= node.next;
        if (node==this._last) this._last= node.prev;
        node.list= undefined;
        //node.next= node.prev = undefined;
        this._count--;
        this._immutableList= undefined;
    }

    delete(value :T) :void;
    delete(node :ListNode<T>) :void;

    delete(nodeOrValue :T | ListNode<T>) {  {}
        if (nodeOrValue instanceof CListNode) return this.deleteNode(nodeOrValue);
        for(let node of this.nodes()) if (node.value==nodeOrValue) this.deleteNode(node);
    }

    deleteFirst() { if (this._first) this.delete(this._first); }
    deleteLast()  { if (this._last) this.delete(this._last); }

    clear() {
        for(let node=this._first; node!=null; node=node.next) this.delete(node);
    }


    private validateNode(node :ListNode<T>) : node is CListNode<T>{
        if (! (node instanceof CListNode)) throw "Wrong node object";
        return node.list==this;  // return throw "Wrong node list";
    }

    private newNode(value :T) : CListNode<T> { return new CListNode(this, value); }
}


export type IList<T> = Readonly<CList<T>>;


type TReadonlyList<TList extends IList<any>>  = Omit<TList,`add${string}`|`set${string}`|`replace${string}`|`delete${string}`|`clear`>

export type IListReadonly<T, TNode extends ListNode<T> = ListNode<T>> = TReadonlyList<Readonly<CList<T, TNode>>>;  // /^joey/i>

export type IListImmutable<T> = IListReadonly<T, ListNodeImm<T>>;



function test() {
    function print(...args: any[]) { console.log(...args); }
    let list= new CList<number>();
    let node10 = list.add(10);
    print(...list.values());
    let node20 = list.add(20);
    print(...list.values());
    let node15 = list.addAfter(node10, 15);
    print(...list.values());
    let node30 = list.addAfter(node20, 30);
    print(...list.values());
    let node25 = list.addBefore(node30, 25);
    print(...list.values());
    let node5 = list.addBefore(node10, 5);
    print(...list.values());
    let node0 = list.addFirst(0)
    print(...list.values());
    print("count:", list.count);
    print("deleting node20")
    list.delete(node20);
    print(...list.values());
    print("count:", list.count);
    print("contains node20:",list.has(node20));
    print("contains 20:",list.has(20));
    print("find 20 -> value:",list.find(20)?.value);
    print("contains node10:",list.has(node10));
    print("contains 10:",list.has(10));
    print("find 10 -> value:",list.find(10)?.value);
    print("adding last 5");
    let nodeLast= list.add(5);
    print(...list.values());
    let listImm= list.toImmutable();
    print("findLast 5 -> prevValue: ",listImm.findLast(5)?.prev?.value);
    print("node15 prev:",list.prev(node15)?.value);
    print("node15 next:",list.next(node15)?.value);
    print("node0 prev:",list.prev(node0)?.value);
    print("nodeLast next:",listImm.next(nodeLast)?.next);
    print("reversed: ",...list.reversedValues());
    print("deleting 5");
    list.delete(5);
    print(...list.values());
    print("clearing");
    list.clear();
    print(...list.values());
    print("count:", list.count);
}

//test();