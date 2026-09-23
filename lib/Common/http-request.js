"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpStatusError = void 0;
exports.httpRequest = httpRequest;
class HttpStatusError extends Error {
    status;
    method;
    url;
    constructor(status, method, url) {
        super(`${method} ${url} failed with status ${status}`);
        this.status = status;
        this.method = method;
        this.url = url;
        this.name = 'HttpStatusError';
    }
}
exports.HttpStatusError = HttpStatusError;
async function httpRequest(url, request = {}) {
    const { json, query, timeoutMs, headers, ...init } = request;
    const target = query ? `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(query)}` : url;
    const method = init.method ?? 'GET';
    const response = await fetch(target, {
        ...init,
        method,
        headers: json === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new HttpStatusError(response.status, method, target);
    }
    return response;
}
