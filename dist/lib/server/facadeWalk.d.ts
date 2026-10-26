export type FacadeWalkEntry = {
    path: string[];
    fn: (...args: any[]) => any;
    context: object;
};
export type FacadeWalkOptions = {
    label: string;
    take?: (value: unknown, path: string[], parent: object) => boolean;
};
export declare function walkFacade(object: object, options: FacadeWalkOptions): FacadeWalkEntry[];
export declare function facadeMember(object: object, path: readonly string[]): unknown;
