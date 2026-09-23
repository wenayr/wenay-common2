export declare function createRpcDeadline(deps: {
    at: number;
    fire: () => void;
    unref?: boolean;
}): {
    cancel(): void;
};
