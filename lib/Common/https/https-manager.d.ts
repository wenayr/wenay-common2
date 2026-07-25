import { HttpsConfigInput } from './https-config';
type HttpsManagerSettings = {
    projectRoot: string;
    configPath?: string;
    onLog?: (message: string) => void;
};
export declare function createNodeHttpsManager(deps: HttpsManagerSettings): {
    ensure: (overrides?: Partial<HttpsConfigInput>) => Promise<{
        changed: boolean;
        running: boolean;
        publicUrl: string;
        pid: number;
        certificate: {
            subject: string;
            issuer: string;
            validFrom: string;
            validTo: string;
            fingerprint256: string;
        };
    }>;
    status: () => Promise<{
        configured: boolean;
        running: boolean;
        owned: boolean;
        pid: number | undefined;
        identity: string | undefined;
        publicUrl: string | undefined;
        backend: string | undefined;
        startedAt: string | undefined;
        certificate: {
            subject: string;
            issuer: string;
            validFrom: string;
            validTo: string;
            fingerprint256: string;
        } | undefined;
        certificateError: string | undefined;
        caddyErrorLog: string;
    }>;
    doctor: (overrides?: Partial<HttpsConfigInput>) => Promise<{
        ok: boolean;
        checks: {
            name: string;
            ok: boolean;
            details: string;
        }[];
    }>;
    stop: () => Promise<{
        stopped: boolean;
        reason: string;
    }>;
};
export type HttpsManager = ReturnType<typeof createNodeHttpsManager>;
export {};
