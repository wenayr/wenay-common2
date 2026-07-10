export type ListNode<T> = {
    readonly value: T;
    readonly [Symbol.species]: CListNode<T>;
};
declare class CListNode<T> implements ListNode<T> {
    value: T;
    list: CList<T> | undefined;
    next?: CListNode<T>;
    prev?: CListNode<T>;
    [Symbol.species]: this;
    constructor(list: CList<T>, value: T);
}
export type ListNodeImm<T> = ListNode<T> & {
    readonly next?: ListNodeImm<T>;
    readonly prev?: ListNodeImm<T>;
    [Symbol.species]: CListNode<T> & "Immutable";
};
export declare class CList<T, TNode extends ListNode<T> = ListNode<T>> implements Iterable<TNode> {
    protected _first?: CListNode<T>;
    protected _last?: CListNode<T>;
    protected _count: number;
    protected _immutableList?: CList<T, ListNodeImm<T>>;
    get first(): CListNode<T> | undefined;
    get last(): CListNode<T> | undefined;
    get count(): number;
    get length(): number;
    get size(): number;
    readonly [Symbol.iterator]: () => Generator<TNode, void, unknown>;
    constructor(values?: Iterable<T>);
    nodes(): Generator<TNode, void, unknown>;
    values(): Generator<T, void, unknown>;
    reversedNodes(): Generator<TNode, void, unknown>;
    reversedValues(): Generator<T, void, unknown>;
    entries(): Generator<readonly [number, T], void, unknown>;
    next(node: ListNode<T>): TNode | undefined;
    prev(node: ListNode<T>): TNode | undefined;
    find(value: T): TNode | undefined;
    findLast(value: T): TNode | undefined;
    private containsValue;
    private containsNode;
    has(value: T): boolean;
    has(node: ListNode<T>): boolean;
    toImmutable(): IListImmutable<T>;
    private _addFirst;
    addFirst(value: T): ListNode<T>;
    addLast(value: T): ListNode<T>;
    addAfter(node: ListNode<T>, value: T): ListNode<T>;
    addBefore(node: ListNode<T>, value: T): ListNode<T>;
    add(value: T): ListNode<T>;
    private set;
    replace(node: ListNode<T>, value: T): ListNode<T>;
    private deleteNode;
    delete(value: T): void;
    delete(node: ListNode<T>): void;
    deleteFirst(): void;
    deleteLast(): void;
    push(value: T): ListNode<T>;
    unshift(value: T): ListNode<T>;
    pop(): T | undefined;
    shift(): T | undefined;
    clear(): void;
    private validateNode;
    private newNode;
}
export type IList<T> = Readonly<CList<T>>;
type TReadonlyList<TList extends IList<any>> = Omit<TList, `add${string}` | `set${string}` | `replace${string}` | `delete${string}` | `clear`>;
export type IListReadonly<T, TNode extends ListNode<T> = ListNode<T>> = TReadonlyList<Readonly<CList<T, TNode>>>;
export type IListImmutable<T> = IListReadonly<T, ListNodeImm<T>>;
export {};
