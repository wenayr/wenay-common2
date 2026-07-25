import { HttpsConfig } from './https-config';
type NodeHttpsResourceDeps = {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    arch?: string;
    homeDir?: string;
    onLog?: (message: string) => void;
};
type HttpsRuntimeState = {
    version: 1;
    pid: number;
    projectRoot: string;
    configPath: string;
    caddyfilePath: string;
    caddyPath: string;
    identity: string;
    publicPort: number;
    challengePort: number;
    bind: string;
    backend: string;
    configHash: string;
    startedAt: string;
};
declare function hashText(value: string): string;
declare function inspectCertificate(config: HttpsConfig, timeoutMs?: number): Promise<{
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    fingerprint256: string;
}>;
export declare function createNodeHttpsResource(deps?: NodeHttpsResourceDeps): {
    project: {
        paths: (projectRoot: string, configPath?: string) => {
            projectRoot: string;
            inputConfigPath: string;
            runtimeDir: string;
            statePath: string;
            stateTempPath: string;
            caddyfilePath: string;
            caddyOutPath: string;
            caddyErrPath: string;
            storageDir: string;
        };
        loadConfig: (projectRoot: string, configPath?: string) => Promise<object | undefined>;
        state: {
            load: (projectRoot: string, configPath?: string) => Promise<HttpsRuntimeState | undefined>;
            save: (state: HttpsRuntimeState) => Promise<void>;
            remove: (projectRoot: string, configPath?: string) => Promise<void>;
        };
        withLock: <T>(projectRoot: string, configPath: string | undefined, task: () => Promise<T>) => Promise<T>;
    };
    caddy: {
        version: string;
        storageDir: string;
        executable: {
            find: (explicitPath?: string) => Promise<string | undefined>;
            ensure: (explicitPath?: string) => Promise<string>;
        };
        config: {
            hash: typeof hashText;
            write: (projectRoot: string, configPath: string | undefined, value: string) => Promise<string>;
            validate: (caddyPath: string, caddyfilePath: string, projectRoot: string) => Promise<void>;
        };
        process: {
            state: (state: HttpsRuntimeState | undefined) => Promise<{
                running: boolean;
                owned: boolean;
                commandLine?: undefined;
            } | {
                running: boolean;
                owned: boolean;
                commandLine: string;
            }>;
            stop: (state: HttpsRuntimeState) => Promise<boolean>;
            start: (projectRoot: string, configPath: string | undefined, caddyPath: string, caddyfilePath: string, config: HttpsConfig, configHash: string) => Promise<HttpsRuntimeState>;
        };
        certificate: {
            inspect: typeof inspectCertificate;
            wait: (config: HttpsConfig, state: HttpsRuntimeState) => Promise<{
                subject: string;
                issuer: string;
                validFrom: string;
                validTo: string;
                fingerprint256: string;
            }>;
        };
    };
    network: {
        inspectBackend: (config: HttpsConfig) => Promise<{
            host: string;
            port: number;
        }>;
        resolveIdentity: (config: HttpsConfig) => Promise<string[]>;
    };
};
export type NodeHttpsResource = ReturnType<typeof createNodeHttpsResource>;
export {};
