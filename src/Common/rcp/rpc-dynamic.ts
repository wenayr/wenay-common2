const dynamicRegistry = new WeakSet<any>()

export function noStrict<T>(obj: T): T {
    dynamicRegistry.add(obj)
    return obj;
}

export function isNoStrict(obj: any): boolean {
    return dynamicRegistry.has(obj)
}
