import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createTokenCodec} from 'wenay-common2/server/auth'

const here = path.dirname(fileURLToPath(import.meta.url))

// Process ownership stays here; domain code never starts or stops processes.
/** @param {{port?: number, nodes?: number, verbose?: boolean, signal?: AbortSignal}} [deps] */
export async function startStand({port = 0, nodes = 2, verbose = false, signal = undefined} = {}) {
    if (!Number.isInteger(nodes) || nodes < 0 || nodes > 8) throw new Error('nodes must be between 0 and 8')
    const nodeToken = process.env.SERVICE_NODE_TOKEN?.trim()
    const tokenSecret = process.env.SERVICE_TOKEN_SECRET?.trim()
    if (process.env.SERVICE_DATA_DIR?.trim() && (!nodeToken || !tokenSecret)) {
        throw new Error('SERVICE_DATA_DIR requires stable SERVICE_NODE_TOKEN and SERVICE_TOKEN_SECRET')
    }
    const secrets = {
        SERVICE_NODE_TOKEN: nodeToken || randomBytes(24).toString('hex'),
        SERVICE_TOKEN_SECRET: tokenSecret || randomBytes(32).toString('hex'),
    }
    const children = []
    const restarts = new Map()
    let closing
    function aborted() { void close() }
    signal?.addEventListener('abort', aborted, {once: true})
    function boot(script, env) {
        if (closing) throw new Error('stand is closing')
        const child = spawn(process.execPath, ['--import', 'tsx', script], {
            cwd: here, env: {...process.env, ...secrets, ...env},
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        let output = ''
        let failure
        const done = new Promise(function waitForExit(resolve) {
            child.once('error', function failed(error) { failure = error; resolve() })
            child.once('exit', resolve)
        })
        function capture(chunk) {
            output = (output + String(chunk)).slice(-24_000)
            if (verbose) process.stdout.write(chunk)
        }
        child.stdout.on('data', capture)
        child.stderr.on('data', capture)
        const entry = {child, done, expected: false, stopping: undefined, output: () => output, failure: () => failure}
        children.push(entry)
        child.once('exit', function unexpectedExit() {
            if (!entry.expected) { process.exitCode = 1; void close() }
        })
        return entry
    }
    async function waitForUrl(entry, pattern) {
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
            if (closing || signal?.aborted) throw new Error('stand startup cancelled')
            if (entry.failure() || entry.child.exitCode != null || entry.child.signalCode != null) {
                throw new Error('stand process failed to start')
            }
            const match = pattern.exec(entry.output())
            if (match) return match[1]
            await new Promise(function tick(resolve) { setTimeout(resolve, 25) })
        }
        throw new Error('stand process readiness timed out')
    }
    function stop(entry) {
        if (entry.stopping) return entry.stopping
        entry.expected = true
        entry.stopping = (async function stopProcess() {
            if (entry.child.exitCode == null && entry.child.signalCode == null) entry.child.kill('SIGTERM')
            const force = setTimeout(function forceExit() { entry.child.kill('SIGKILL') }, 1500)
            try { await entry.done } finally { clearTimeout(force) }
        })()
        return entry.stopping
    }
    function close() {
        if (closing) return closing
        signal?.removeEventListener('abort', aborted)
        closing = (async function closeResources() {
            await Promise.all(children.map(stop))
            await Promise.allSettled([...restarts.values()])
        })()
        return closing
    }
    try {
        if (signal?.aborted) throw new Error('stand startup cancelled')
        const leader = boot('leader-rental.ts', {RENTAL_PORT: String(port)})
        const url = await waitForUrl(leader, /leader listening on (http:\/\/localhost:\d+)/)
        const nodeUrls = []
        const nodeEntries = []
        for (let i = 0; i < nodes; i++) {
            const node = boot('node-rental.ts', {SERVICE_NODE_ID: 'rental-node-' + i, SERVICE_UPSTREAM: url, SERVICE_PORT: '0'})
            nodeEntries.push(node)
            nodeUrls.push(await waitForUrl(node, /serving at (http:\/\/localhost:\d+)/))
        }
        function restartNode(index) {
            if (closing) throw new Error('stand is closing')
            if (!nodeEntries[index]) throw new Error('node unavailable')
            const existing = restarts.get(index)
            if (existing) return existing
            const operation = (async function replaceNode() {
                await stop(nodeEntries[index])
                if (closing) throw new Error('stand is closing')
                const replacement = boot('node-rental.ts', {
                    SERVICE_NODE_ID: 'rental-node-' + index, SERVICE_UPSTREAM: url,
                    SERVICE_PORT: new URL(nodeUrls[index]).port,
                })
                nodeEntries[index] = replacement
                await waitForUrl(replacement, /serving at (http:\/\/localhost:\d+)/)
                if (closing) throw new Error('stand closed during node startup')
            })().finally(function finished() { restarts.delete(index) })
            restarts.set(index, operation)
            return operation
        }
        const token = createTokenCodec({secret: secrets.SERVICE_TOKEN_SECRET, ttlMs: 60_000}).issue({sub: 'demo-renter'})
        return {url, nodeUrls, token, restartNode, close, view: {
            processes: () => children.map(entry => ({pid: entry.child.pid,
                exited: entry.child.exitCode != null || entry.child.signalCode != null || entry.failure() != undefined})),
        }}
    } catch (error) {
        await close()
        throw error
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) == fileURLToPath(import.meta.url)) {
    const stop = new AbortController()
    function shutdown() { stop.abort() }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    const stand = await startStand({port: Number(process.env.RENTAL_PORT ?? 3400), nodes: Number(process.env.RENTAL_NODES ?? 2), verbose: true, signal: stop.signal})
    console.log('Board: ' + stand.url + '/board')
    console.log('Swagger: ' + stand.url + '/docs')
    console.log('Reader endpoints: ' + [stand.url, ...stand.nodeUrls].join(', '))
}
