export declare const HTTPS_COMMANDS: {
    readonly ensure: 'ensure';
    readonly status: 'status';
    readonly doctor: 'doctor';
    readonly stop: 'stop';
};
export type tHttpsCommand = keyof typeof HTTPS_COMMANDS;
export type HttpsConfigInput = {
    identity: string;
    backend: string;
    publicPort?: number;
    challengePort?: number;
    bind?: string;
    email?: string;
    certificateWaitSeconds?: number;
    caddyPath?: string;
};
export declare function normalizeHttpsConfig(input: HttpsConfigInput): {
    identity: string;
    backend: string;
    publicPort: number;
    challengePort: number;
    bind: string;
    email: string | undefined;
    certificateWaitSeconds: number;
    caddyPath: string | undefined;
    rawIp: boolean;
};
export type HttpsConfig = ReturnType<typeof normalizeHttpsConfig>;
export declare function httpsPublicUrl(config: Pick<HttpsConfig, 'identity' | 'publicPort'>): string;
export declare function createCaddyfile(config: HttpsConfig, storageDir: string): string;
