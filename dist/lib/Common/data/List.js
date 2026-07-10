"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CList = void 0;
class CListNode {
    value;
    list;
    next;
    prev;
    [Symbol.species] = this;
    constructor(list, value) { this.list = list; this.value = value; }
}
class CList {
    _first;
    _last;
    _count = 0;
    _immutableList;
    get first() { return this._first; }
    get last() { return this._last; }
    get count() { return this._count; }
    get length() { return this._count; }
    get size() { return this._count; }
    [Symbol.iterator] = this.nodes;
    constructor(values = []) { for (let value of values)
        this.add(value); }
    *nodes() { for (let node = this._first; node != null;) {
        yield node;
        node = node.next;
    } }
    *values() { for (let node of this)
        yield node.value; }
    *reversedNodes() { for (let node = this._last; node != null;) {
        yield node;
        node = node.prev;
    } }
    *reversedValues() { for (let node of this.reversedNodes())
        yield node.value; }
    *entries() { let i = 0; for (let node of this.nodes())
        yield [i++, node.value]; }
    next(node) { return this.validateNode(node) ? node.next : (() => { throw "Wrong node list"; })(); }
    ;
    prev(node) { return this.validateNode(node) ? node.prev : (() => { throw "Wrong node list"; })(); }
    ;
    find(value) { for (let node of this.nodes())
        if (node.value == value)
            return node; return undefined; }
    findLast(value) { for (let node of this.reversedNodes())
        if (node.value == value)
            return node; return undefined; }
    containsValue(value) { return this.find(value) != undefined; }
    containsNode(node) { return this.validateNode(node); }
    has(data) { return data instanceof CListNode ? this.containsNode(data) : this.containsValue(data); }
    toImmutable() { return this._immutableList ??= new CList(this.values()); }
    _addFirst(value) {
        this._count = 1;
        this._immutableList = undefined;
        return this._first = this._last = this.newNode(value);
    }
    addFirst(value) {
        if (this._first)
            return this.addBefore(this._first, value);
        return this._addFirst(value);
    }
    addLast(value) {
        if (this._last)
            return this.addAfter(this._last, value);
        return this._addFirst(value);
    }
    addAfter(node, value) {
        if (!this.validateNode(node))
            throw "Wrong node list";
        let newNode = this.newNode(value);
        newNode.prev = node;
        newNode.next = node.next;
        if (node.next)
            node.next.prev = newNode;
        else
            this._last = newNode;
        node.next = newNode;
        this._count++;
        this._immutableList = undefined;
        return newNode;
    }
    addBefore(node, value) {
        if (!this.validateNode(node))
            throw "Wrong node list";
        let newNode = this.newNode(value);
        newNode.next = node;
        newNode.prev = node.prev;
        if (node.prev)
            node.prev.next = newNode;
        else
            this._first = newNode;
        node.prev = newNode;
        this._count++;
        this._immutableList = undefined;
        return newNode;
    }
    add(value) { return this.addLast(value); }
    set(node, value) {
        if (!this.validateNode(node))
            throw "Wrong node list";
        node.value = value;
        return node;
    }
    replace(node, value) {
        if (!this.validateNode(node))
            throw "Wrong node list";
        let newNode = this.newNode(value);
        newNode.next = node.next;
        newNode.prev = node.prev;
        if (node.prev)
            node.prev.next = newNode;
        else
            this._first = newNode;
        if (node.next)
            node.next.prev = newNode;
        else
            this._last = newNode;
        node.list = undefined;
        node.next = node.prev = undefined;
        this._immutableList = undefined;
        return newNode;
    }
    deleteNode(node) {
        if (!this.validateNode(node))
            throw "Wrong node list";
        if (node.prev)
            node.prev.next = node.next;
        if (node.next)
            node.next.prev = node.prev;
        if (node == this._first)
            this._first = node.next;
        if (node == this._last)
            this._last = node.prev;
        node.list = undefined;
        this._count--;
        this._immutableList = undefined;
    }
    delete(nodeOrValue) {
        { }
        if (nodeOrValue instanceof CListNode)
            return this.deleteNode(nodeOrValue);
        for (let node of this.nodes())
            if (node.value == nodeOrValue)
                this.deleteNode(node);
    }
    deleteFirst() { if (this._first)
        this.delete(this._first); }
    deleteLast() { if (this._last)
        this.delete(this._last); }
    push(value) { return this.addLast(value); }
    unshift(value) { return this.addFirst(value); }
    pop() { let value = this._last?.value; this.deleteLast(); return value; }
    shift() { let value = this._first?.value; this.deleteFirst(); return value; }
    clear() {
        for (let node = this._first; node != null; node = node.next)
            node.list = undefined;
        this._first = this._last = undefined;
        this._count = 0;
        this._immutableList = undefined;
    }
    validateNode(node) {
        if (!(node instanceof CListNode))
            throw "Wrong node object";
        return node.list == this;
    }
    newNode(value) { return new CListNode(this, value); }
}
exports.CList = CList;
function test() {
    function print(...args) { console.log(...args); }
    let list = new CList();
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
    let node0 = list.addFirst(0);
    print(...list.values());
    print("count:", list.count);
    print("deleting node20");
    list.delete(node20);
    print(...list.values());
    print("count:", list.count);
    print("contains node20:", list.has(node20));
    print("contains 20:", list.has(20));
    print("find 20 -> value:", list.find(20)?.value);
    print("contains node10:", list.has(node10));
    print("contains 10:", list.has(10));
    print("find 10 -> value:", list.find(10)?.value);
    print("adding last 5");
    let nodeLast = list.add(5);
    print(...list.values());
    let listImm = list.toImmutable();
    print("findLast 5 -> prevValue: ", listImm.findLast(5)?.prev?.value);
    print("node15 prev:", list.prev(node15)?.value);
    print("node15 next:", list.next(node15)?.value);
    print("node0 prev:", list.prev(node0)?.value);
    print("nodeLast next:", listImm.next(nodeLast)?.next);
    print("reversed: ", ...list.reversedValues());
    print("deleting 5");
    list.delete(5);
    print(...list.values());
    print("clearing");
    list.clear();
    print(...list.values());
    print("count:", list.count);
}
