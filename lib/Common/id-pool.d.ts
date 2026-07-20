export declare const createIdPool: () => {
    next: () => number;
    release(id: number): void;
};
export type idPool = ReturnType<typeof createIdPool>;
export declare const createNodeIdMinter: (opts: {
    node: string;
    start?: number;
}) => {
    node: string;
    next: (kind?: string) => string;
    adopt(ids: Iterable<string>): number;
    current: () => number;
};
export type NodeIdMinter = ReturnType<typeof createNodeIdMinter>;
