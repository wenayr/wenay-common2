export declare class HttpStatusError extends Error {
    readonly status: number;
    readonly method: string;
    readonly url: string;
    constructor(status: number, method: string, url: string);
}
export type tHttpRequest = Omit<RequestInit, 'body' | 'signal'> & {
    json?: unknown;
    query?: Record<string, string>;
    timeoutMs?: number;
};
export declare function httpRequest(url: string, request?: tHttpRequest): Promise<Response>;
