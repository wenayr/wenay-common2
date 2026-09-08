#!/usr/bin/env node
// =====================================================================
// pizzeria stand — leader + N serving nodes, all real OS processes
// =====================================================================
// Plain node. The orchestrator owns what an orchestrator owns: it mints the
// corridor secrets ONCE and hands them to every process through env, boots
// the leader, waits for its port, spawns the nodes, and stops everything on
// Ctrl+C. Importable: check.ts starts a stand on ephemeral ports.

import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** @param {{port?: number, nodes?: number, verbose?: boolean, signal?: AbortSignal}} [deps] */
export async function startStand({port = 0, nodes = 2, verbose = false, signal = undefined} = {}) {
    if (!Number.isInteger(nodes) || nodes < 0 || nodes > 8) throw new Error('nodes must be between 0 and 8')
    const secrets = {
        SERVICE_NODE_TOKEN: randomBytes(24).toString('hex'),
        SERVICE_TOKEN_SECRET: randomBytes(32).toString('hex'),
    }
    const children = []
    let closing
    function aborted() { void close() }
    signal?.addEventListener('abort', aborted, {once: true})
    function boot(script, env) {
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
        const entry = {child, done, expected: false, output: () => output, failure: () => failure}
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
                throw new Error('stand process failed to start:\n' + entry.output())
            }
            const match = pattern.exec(entry.output())
            if (match) return match[1]
            await new Promise(function tick(resolve) { setTimeout(resolve, 25) })
        }
        throw new Error('stand process readiness timed out')
    }
    async function stop(entry) {
        entry.expected = true
        if (entry.child.exitCode == null && entry.child.signalCode == null) entry.child.kill('SIGTERM')
        const force = setTimeout(function forceExit() { entry.child.kill('SIGKILL') }, 1500)
        try { await entry.done } finally { clearTimeout(force) }
    }
    function close() {
        if (closing) return closing
        signal?.removeEventListener('abort', aborted)
        closing = Promise.all(children.map(stop))
        return closing
    }
    try {
        if (signal?.aborted) throw new Error('stand startup cancelled')
        const leader = boot('leader-pizzeria.ts', {SERVICE_PORT: String(port)})
        const url = await waitForUrl(leader, /leader listening on (http:\/\/localhost:\d+)/)
        const nodeUrls = []
        for (let i = 0; i < nodes; i++) {
            const node = boot('node-pizzeria.ts', {SERVICE_NODE_ID: 'pizzeria-node-' + i, SERVICE_UPSTREAM: url, SERVICE_PORT: '0'})
            nodeUrls.push(await waitForUrl(node, /serving at (http:\/\/localhost:\d+)/))
        }
        return {url, nodeUrls, close}
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
    const stand = await startStand({port: Number(process.env.SERVICE_PORT ?? 3500), nodes: Number(process.env.PIZZERIA_NODES ?? 2), verbose: true, signal: stop.signal})
    console.log('Panel: ' + stand.url + '/panel')
    console.log('Swagger: ' + stand.url + '/docs')
    console.log('Reader endpoints: ' + [stand.url, ...stand.nodeUrls].join(', '))
}
