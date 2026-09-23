// Internal HTTP request over the platform fetch (Node >= 20, browsers). It keeps the two axios
// behaviours callers relied on: a non-2xx status rejects, and a timeout aborts the request.
// Not a public export; server/webhook and the HTTPS resource share it.

export class HttpStatusError extends Error {
    constructor(readonly status: number, readonly method: string, readonly url: string) {
        super(`${method} ${url} failed with status ${status}`)
        this.name = 'HttpStatusError'
    }
}

export type tHttpRequest = Omit<RequestInit, 'body' | 'signal'> & {
    json?: unknown
    query?: Record<string, string>
    timeoutMs?: number
}

export async function httpRequest(url: string, request: tHttpRequest = {}) {
    const {json, query, timeoutMs, headers, ...init} = request
    const target = query ? `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(query)}` : url
    const method = init.method ?? 'GET'
    const response = await fetch(target, {
        ...init,
        method,
        headers: json === undefined ? headers : {'content-type': 'application/json', ...headers},
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!response.ok) {
        // drain so the socket returns to the pool before the rejection
        await response.arrayBuffer().catch(() => undefined)
        throw new HttpStatusError(response.status, method, target)
    }
    return response
}
