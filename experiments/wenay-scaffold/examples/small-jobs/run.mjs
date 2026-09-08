#!/usr/bin/env node
// =====================================================================
// small-jobs stand — leader + N nodes, all real OS processes
// =====================================================================
// Plain node, no dependencies. The orchestrator owns what an orchestrator
// owns: it mints the corridor secrets ONCE and hands them to every process
// through env, boots the leader, waits for its port, spawns the nodes,
// prints the URLs and the seeded logins, and forwards Ctrl+C. Importable:
// startStand() is what the example's check drives.
// Run: node experiments/wenay-scaffold/examples/small-jobs/run.mjs

import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** @param {{port?: number, nodes?: number, verbose?: boolean, signal?: AbortSignal}} [deps] */
export async function startStand({port = 0, nodes = 2, verbose = false, signal = undefined} = {}) {
    if (!Number.isInteger(nodes) || nodes < 0 || nodes > 8) throw new Error('nodes must be between 0 and 8')
    const secrets = {
        SERVICE_NODE_TOKEN: 'node-' + randomBytes(24).toString('hex'),
        SERVICE_TOKEN_SECRET: 'auth-' + randomBytes(32).toString('hex'),
    }
    const children = []
    const restarts = new Map()
    let closing
    function aborted() { void close() }
    signal?.addEventListener('abort', aborted, {once: true})
    function boot(label, script, env) {
        if (closing) throw new Error('stand is closing')
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, script)], {
            cwd: here,
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
            if (entry.failure() || entry.child.exitCode != null || entry.child.signalCode != null) {
                throw new Error('stand process failed to start:\n' + entry.output())
            }
            if (closing || signal?.aborted) throw new Error('stand startup cancelled')
            const match = pattern.exec(entry.output())
            if (match) return match[1]
            await new Promise(function tick(resolve) { setTimeout(resolve, 25) })
        }
        throw new Error('stand process readiness timed out:\n' + entry.output())
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
        const leader = boot('leader', 'leader-small-jobs.ts', {SERVICE_PORT: String(port)})
        const url = await waitForUrl(leader, /leader listening on (http:\/\/localhost:\d+)/)
        const nodeUrls = []
        const nodeEntries = []
        for (let i = 0; i < nodes; i++) {
            const node = boot('node-' + i, 'node-small-jobs.ts', {SERVICE_NODE_ID: 'small-jobs-node-' + i, SERVICE_UPSTREAM: url, SERVICE_PORT: '0'})
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
                const replacement = boot('node-' + index, 'node-small-jobs.ts', {
                    SERVICE_NODE_ID: 'small-jobs-node-' + index, SERVICE_UPSTREAM: url,
                    SERVICE_PORT: new URL(nodeUrls[index]).port,
                })
                nodeEntries[index] = replacement
                await waitForUrl(replacement, /serving at (http:\/\/localhost:\d+)/)
                if (closing) throw new Error('stand closed during node startup')
            })().finally(function finished() { restarts.delete(index) })
            restarts.set(index, operation)
            return operation
        }
        return {url, nodeUrls, restartNode, close, view: {
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
    const stand = await startStand({port: Number(process.env.SMALL_JOBS_PORT ?? 3600), nodes: Number(process.env.SMALL_JOBS_NODES ?? 2), verbose: true, signal: stop.signal})
    console.log('[run] small-jobs stand is up — Ctrl+C stops leader and nodes')
    console.log('[run]   panel:   ' + stand.url + '/panel   (log in as alice/alice-pass, bella/bella-pass, will/will-pass, wendy/wendy-pass)')
    console.log('[run]   docs:    ' + stand.url + '/docs')
    console.log('[run]   nodes:   ' + stand.nodeUrls.join(', '))
}

