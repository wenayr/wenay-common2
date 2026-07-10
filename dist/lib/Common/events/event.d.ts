export type tListEvent<T = any, T2 = void> = {
    func?: (data?: T) => T2;
    func2?: (data?: T) => void;
    del?: () => void;
    OnDel?: () => void;
};
export declare class CObjectEventsArr<T extends object> {
    private data;
    private setup;
    AddStart(data: tListEvent): void;
    AddEnd(data: tListEvent): void;
    Add(data: tListEvent): void;
    add(data: tListEvent, opts?: {
        at?: 'start' | 'end';
    }): void;
    OnEvent(data?: any): void;
    emit(data?: any): void;
    OnSpecEvent(f: (e: T) => void): void;
    Clean(): void;
    clear(): void;
    count(): number;
    get length(): number;
    get size(): number;
}
export declare class CObjectEventsList<T = unknown> {
    constructor(log?: boolean);
    Id: number;
    private _log;
    private data;
    private setup;
    log(): void;
    AddStart(data: tListEvent): void;
    AddEnd(data: tListEvent): void;
    Add(data: tListEvent): void;
    add(data: tListEvent, opts?: {
        at?: 'start' | 'end';
    }): void;
    OnEvent(data?: T): void;
    emit(data?: T): void;
    OnSpecEvent<R>(f: (e?: R) => void): void;
    Clean(): void;
    clear(): void;
    count(): number;
    get length(): number;
    get size(): number;
}
