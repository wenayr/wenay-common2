import {createServer} from 'node:http'

// Only these bundled applications can run; no source code or command arrives from a user.
export const releases = {
    v1: {title: 'Welcome to your first site', healthy: true},
    v2: {title: 'Your site has a fresh release', healthy: true},
    broken: {title: 'Unhealthy release', healthy: false},
} as const
export type tRelease = keyof typeof releases

function main() {
    const release = process.argv[2] as tRelease
    const tenant = process.argv[3]
    if (!Object.hasOwn(releases, release) || !tenant) throw new Error('unknown bundled application')
    let requests = 0
    const server = createServer(async function serve(request, response) {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname == '/health') {
            response.writeHead(releases[release].healthy ? 200 : 503)
            response.end('health')
            return
        }
        requests++
        process.send?.({type: 'requests', pending: requests})
        try {
            const delay = Math.min(2000, Math.max(0, Number(url.searchParams.get('delayMs')) || 0))
            if (delay) await new Promise(function wait(resolve) { setTimeout(resolve, delay) })
            response.setHeader('content-type', 'text/html; charset=utf-8')
            response.setHeader('x-release', release)
            response.setHeader('x-tenant', tenant)
            response.end(`<!doctype html><html><head><title>${tenant}</title></head><body><h1>${releases[release].title}</h1><p>Site: ${tenant}</p><p>Release: ${release}</p></body></html>`)
        } finally {
            requests--
            process.send?.({type: 'requests', pending: requests})
        }
    })
    server.listen(0, '127.0.0.1', function ready() {
        const address = server.address()
        if (!address || typeof address == 'string') throw new Error('missing app address')
        process.send?.({type: 'ready', port: address.port})
    })
    process.on('message', function shutdown(message: unknown) {
        if ((message as {type?: string})?.type == 'shutdown') {
            server.close(function stopped() { process.disconnect?.() })
        }
    })
    process.on('disconnect', function parentGone() { server.close() })
}

if (require.main == module) main()
