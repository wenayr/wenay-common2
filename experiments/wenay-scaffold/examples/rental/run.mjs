#!/usr/bin/env node
// =====================================================================
// rental stand — leader + 2 nodes, all real OS processes
// =====================================================================
// Plain node, no dependencies. This orchestrator owns what an orchestrator
// owns (the mini-scale spawnNode pattern): it mints the corridor secrets ONCE
// and hands them to every process through env, boots the leader, waits for
// its port, spawns the nodes, prints the URLs, and forwards Ctrl+C.
//
// Run: node experiments/wenay-scaffold/examples/rental/run.mjs

import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..', '..', '..')
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const port = Number(process.env.RENTAL_PORT ?? 3400)
const nodes = 2

// one secret pair for the whole stand: the leader pins them, the nodes join with them
const nodeToken = 'node-' + randomBytes(12).toString('hex')
const tokenSecret = 'auth-' + randomBytes(12).toString('hex')

const children = []
let closing = false

function boot(label, script, env) {
    const child = spawn(process.execPath, [tsxCli, script], {
        env: {...process.env, ...env},
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', function childOut(chunk) { process.stdout.write(`[${label}] ${chunk}`) })
    child.stderr.on('data', function childErr(chunk) { process.stderr.write(`[${label}] ${chunk}`) })
    child.on('exit', function childGone(code) {
        console.log(`[run] ${label} exited (${code ?? 'signal'})`)
        // the stand is one unit: a dead leader takes the stand down
        if (label == 'leader' && !closing) shutdown('leader exited')
    })
    children.push(child)
    return child
}

async function waitForLeader() {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        try {
            const answer = await fetch(`http://localhost:${port}/openapi.json`)
            if (answer.ok) return
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`leader did not answer on port ${port} within 30s`)
}

function shutdown(reason) {
    if (closing) return
    closing = true
    console.log(`\n[run] ${reason} — stopping the stand`)
    // SIGINT lets each process run its own graceful leave (drain grace, goodbye)
    for (const child of children) child.kill('SIGINT')
    setTimeout(function exitNow() { process.exit(0) }, 2_000)
}

boot('leader', path.join(here, 'leader-rental.ts'), {
    RENTAL_PORT: String(port),
    SERVICE_NODE_TOKEN: nodeToken,
    SERVICE_TOKEN_SECRET: tokenSecret,
})
await waitForLeader()

for (let index = 1; index <= nodes; index++) {
    boot('node-' + index, path.join(here, 'node-rental.ts'), {
        SERVICE_NODE_ID: 'rental-node-' + index,
        SERVICE_UPSTREAM: `http://localhost:${port}`,
        SERVICE_NODE_TOKEN: nodeToken,
        SERVICE_TOKEN_SECRET: tokenSecret,
    })
}

console.log(`[run] rental stand is up — Ctrl+C stops leader and nodes`)
console.log(`[run]   board:   http://localhost:${port}/board`)
console.log(`[run]   docs:    http://localhost:${port}/docs`)
console.log(`[run]   openapi: http://localhost:${port}/openapi.json`)
console.log(`[run] the leader printed the demo bearer + a ready-made curl above`)

process.on('SIGINT', function onSigint() { shutdown('SIGINT') })
process.on('SIGTERM', function onSigterm() { shutdown('SIGTERM') })
