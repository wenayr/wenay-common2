export declare const createIdPool: () => {
    next: () => number;
    release(id: number): void;
};
export type idPool = ReturnType<typeof createIdPool>;
