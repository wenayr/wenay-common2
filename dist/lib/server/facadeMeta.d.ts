export type McpToolAnnotations = {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
};
export type FacadeMethodArg = {
    name: string;
    schema: object;
    description?: string;
    optional?: boolean;
};
export type FacadeMethodMeta = {
    description: string;
    title?: string;
    input?: object;
    args?: readonly FacadeMethodArg[];
    output?: object;
    annotations?: McpToolAnnotations;
    context?: boolean;
};
export type tFacadeMetaMap = Readonly<Record<string, FacadeMethodMeta>>;
export type FacadeDynamicMeta = {
    description: string;
    title?: string;
    key?: object;
    members?: Readonly<Record<string, FacadeMethodMeta>>;
    annotations?: McpToolAnnotations;
};
export declare function checkMethodMeta(meta: unknown, where: string): FacadeMethodMeta;
export declare function checkDynamicMeta(meta: unknown, where: string): FacadeDynamicMeta;
export declare function describeMethod<F extends (...args: any[]) => any>(fn: F, meta: FacadeMethodMeta): F;
export declare function methodMeta(fn: unknown): FacadeMethodMeta | undefined;
export declare function describeDynamic<T extends object>(node: T, meta: FacadeDynamicMeta): T;
export declare function dynamicMeta(node: unknown): FacadeDynamicMeta | undefined;
export declare function facadeMetaKey(path: readonly string[]): string;
export declare function checkMetaMap(map: tFacadeMetaMap | undefined): Readonly<Record<string, FacadeMethodMeta>> | undefined;
export declare function resolveMethodMeta(fn: unknown, path: readonly string[], map?: tFacadeMetaMap): FacadeMethodMeta | undefined;
export declare function methodInputSchema(meta: FacadeMethodMeta | undefined): Record<string, unknown>;
export declare function methodArgTuple(meta: FacadeMethodMeta | undefined): object[] | undefined;
