import type { Express } from 'express';
import axios from 'axios';
interface Subscriber {
    url: string;
    tag: string;
    expireAt: Date;
}
interface WebhookClientOptions {
    serverUrl: string;
    clientPort: number;
    authToken: string;
    autoRenew?: boolean;
    renewIntervalMs?: number;
    app?: Express;
}
declare const loadSubscribers: () => Map<string, Subscriber>;
declare const saveSubscribers: (subs: Map<string, Subscriber>) => void;
export declare const buildSelfWebhookUrl: (clientIp: string, raw: unknown) => string | null;
export declare const apiSaveData: {
    loadSubscribers: typeof loadSubscribers;
    saveSubscribers: typeof saveSubscribers;
};
type params = {
    authToken: string;
    port: number | string;
    file?: typeof apiSaveData;
    app?: Express;
};
export declare const createWebhookServer: (params: params) => {
    emit: (tag: string, payload: any) => Promise<void>;
    appServerReady: Promise<void>;
};
export declare const createWebhookClient: (options: WebhookClientOptions) => {
    connect: (tag: string, handler: (payload: any) => void) => Promise<void>;
    unsubscribe: (...tags: string[]) => Promise<void>;
    status: (tag: string) => Promise<axios.AxiosResponse<any, any, {}>>;
    tags: () => string[];
    getMySubscriptions: () => Promise<Subscriber[]>;
    getAvailableTags: () => Promise<string[]>;
    Provider: (tag: string, payload: any) => Promise<void>;
    appServerReady: Promise<void>;
};
export {};
