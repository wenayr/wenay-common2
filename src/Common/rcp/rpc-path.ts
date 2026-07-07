export function rpcPathKey(path: readonly string[]): string {
    return JSON.stringify(path);
}
