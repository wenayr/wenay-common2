#!/usr/bin/env node
// =====================================================================
// pizzeria stand — leader + N nodes, all real OS processes
// =====================================================================
// Plain node, no dependencies. The orchestrator owns what an orchestrator
// owns: it mints the corridor secrets ONCE and hands them to every process
// through env, boots the leader, waits for its port, spawns the nodes,
// prints the URLs and the seeded logins, and forwards Ctrl+C. Importable:
// startStand() is what the example's check drives.
// Run: node experiments/wenay-scaffold/examples/pizzeria/run.mjs

import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..', '..', '..')
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** @param {{port?: number, nodes?: number, verbose?: boolean, signal?: AbortSignal}} [deps] */
export async function startStand({port = 0, nodes = 2, verbose = false, signal = undefined} = {}) {
    if (!Number.isInteger(nodes) || nodes < 0 || nodes > 8) throw new Error('nodes must be between 0 and 8')
    const secrets = {
        SERVICE_NODE_TOKEN: 'node-' + randomBytes(24).toString('hex'),
        SERVICE_TOKEN_SECRET: 'auth-' + randomBytes(32).toString('hex'),
    }
    const children = []
    let closing
    function aborted() { void close() }
    signal?.addEventListener('abort', aborted, {once: true})
    function boot(label, script, env) {
        const child = spawn(process.execPath, [tsxCli, path.join(here, script)], {
            env: {...process.env, ...secrets, ...env},
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
            if (verbose) process.stdout.write(`[${label}] ${chunk}`)
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
        throw new Error('stand process readiness timed out:\n' + entry.output())
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
        const leader = boot('leader', 'leader-pizzeria.ts', {SERVICE_PORT: String(port)})
        const url = await waitForUrl(leader, /leader listening on (http:\/\/localhost:\d+)/)
        const nodeUrls = []
        const nodeEntries = []
        for (let i = 0; i < nodes; i++) {
            const node = boot('node-' + i, 'node-pizzeria.ts', {SERVICE_NODE_ID: 'pizzeria-node-' + i, SERVICE_UPSTREAM: url, SERVICE_PORT: '0'})
            nodeEntries.push(node)
            nodeUrls.push(await waitForUrl(node, /serving at (http:\/\/localhost:\d+)/))
        }
        async function restartNode(index) {
            if (closing || !nodeEntries[index]) throw new Error('node unavailable')
            await stop(nodeEntries[index])
            const replacement = boot('node-' + index, 'node-pizzeria.ts', {
                SERVICE_NODE_ID: 'pizzeria-node-' + index, SERVICE_UPSTREAM: url,
                SERVICE_PORT: new URL(nodeUrls[index]).port,
            })
            nodeEntries[index] = replacement
            await waitForUrl(replacement, /serving at (http:\/\/localhost:\d+)/)
        }
        return {url, nodeUrls, restartNode, close}
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
    const stand = await startStand({port: Number(process.env.PIZZERIA_PORT ?? 3500), nodes: Number(process.env.PIZZERIA_NODES ?? 2), verbose: true, signal: stop.signal})
    console.log('[run] pizzeria stand is up — Ctrl+C stops leader and nodes')
    console.log('[run]   panel:   ' + stand.url + '/panel   (log in as owner/owner-pass, chef/chef-pass, rider/rider-pass, alice/alice-pass)')
    console.log('[run]   docs:    ' + stand.url + '/docs')
    console.log('[run]   nodes:   ' + stand.nodeUrls.join(', '))
}
