export {};
export declare function enable(flag?: boolean): void;
export declare function disable(): void;
export declare function installConsoleCallerAnnotations(): void;
export declare function __LineFile(lvl?: number): string;
export declare function __LineFile2(lvl?: number): string;
export declare function __LineFiles(lvlStart?: number, lvlEnd?: number | undefined): string[];
export declare const callerLine: typeof __LineFile2;
export declare const callerLines: typeof __LineFiles;
