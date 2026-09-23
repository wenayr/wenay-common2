export type tEnv = Record<string, string | undefined>;
export declare function requiredEnv(env: tEnv, name: string): string;
export declare function optionalEnv(env: tEnv, name: string): string | undefined;
export declare function portEnv(env: tEnv, name: string): number | undefined;
export declare function servicePublicUrl(value: string | undefined): string | undefined;
export declare function corsOrigins(env: tEnv, known: string[]): true | string[];
export declare function nodeEnv(env: tEnv): {
    nodeId: string;
    upstream: string;
    nodeToken: string;
    tokenSecret: string;
    port: number | undefined;
    host: string | undefined;
    publicUrl: string | undefined;
};
export declare function leaderEnv(env: tEnv): {
    port: number | undefined;
    host: string | undefined;
    publicUrl: string | undefined;
    dataDir: string | undefined;
    secrets: {
        nodeToken?: string | undefined;
        tokenSecret?: string | undefined;
    };
};
