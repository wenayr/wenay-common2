// =====================================================================
// Agent HTTP control self-client — the "MCP-lite" loop
// =====================================================================
// A running host exposes a small control facade as HTTP routes, and the
// development module bridge makes the watched file's own methods callable by
// name. The client half of this file talks to the host ONLY through fetch +
// JSON — exactly like an AI agent following
// doc/prompts/IMPLEMENT-AGENT-HTTP-CONTROL.md would.
//
// The bridge itself is demo/dev-module-bridge.ts, the same one the demo stand
// runs, so this example verifies the shipped implementation rather than a
// private copy of it.

import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import express from 'express'

import {createDevModuleBridge} from '../../demo/dev-module-bridge'

const TOKEN = 'agent-control-self-client-token'
const POLL_MS = 40
const WAIT_TIMEOUT_MS = 15_000

// =====================================================================
// The developer's module file
// =====================================================================

function moduleSource(greeting: string, extraMethods = '') {
    return `function createGreeting() {
    return {
        'health.warmup'() { return {ok: true} },
        'health.check'() { return {ok: true} },
        greet(input, call) {
            return {
                ok: true,
                message: ${JSON.stringify(greeting)} + ', ' + input,
                bindingGeneration: call.bindingGeneration,
            }
        },${extraMethods}
    }
}`
}

// A method the developer adds mid-session. Nothing declares it anywhere: it is
// callable the moment the file is saved.
const STATS_METHOD = `
        stats(input) {
            return {ok: true, method: 'stats', input}
        },`

// =====================================================================
// Host side: dev module bridge plus a small static control facade
// =====================================================================

async function startHost(moduleFile: string, guideText: string) {
    const app = express()

    function authorizeAgent(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (req.headers.authorization == 'Bearer ' + TOKEN) {
            next()
            return
        }
        res.status(401).json({ok: false, error: {message: 'Unauthorized'}})
    }

    // The dynamic half: /agent/methods, /agent/snapshot, /agent/call/:method
    const bridge = createDevModuleBridge({
        app,
        file: moduleFile,
        basePath: '/agent',
        middleware: authorizeAgent,
        slotId: 'greeting.primary',
        moduleId: 'greeting.impl',
        contractId: 'greeting.port',
        capability: 'greeting',
        pollMs: POLL_MS,
    })

    // The static half: commands and self-description, walked once.
    const {createHttpFacadeServer} = await import('../../src/server/httpFacadeServer.js')
    const limits = {maxDepth: 8, maxKeys: 200, maxArgs: 4, maxArrayLen: 100, maxStringLen: 1_000_000}
    createHttpFacadeServer({
        app,
        object: {
            health: {snapshot: bridge.health.snapshot},
            resource: {guide: () => guideText},
        },
        method: 'get',
        basePath: '/agent',
        middleware: authorizeAgent,
        limits,
    })
    createHttpFacadeServer({
        app,
        object: {control: {reload: bridge.control.reload, rollback: bridge.control.rollback}},
        method: 'post',
        basePath: '/agent',
        // Reject unauthorized calls before spending work parsing their bodies.
        middleware: [authorizeAgent, express.json({limit: '64kb'})],
        limits,
    })

    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(function waitListening(resolveListening, rejectListening) {
        server.once('listening', resolveListening)
        server.once('error', rejectListening)
    })
    const address = server.address()
    if (address == null || typeof address == 'string') throw new Error('missing HTTP server address')

    await bridge.control.start()

    async function close() {
        await new Promise<void>(function closeServer(resolveClose) {
            server.close(function closed() { resolveClose() })
        })
        await bridge.control.close()
    }

    return {port: address.port, close}
}

// =====================================================================
// Agent side: fetch and JSON only
// =====================================================================

function createAgentHttpClient(port: number) {
    const base = 'http://127.0.0.1:' + port

    async function settle(response: Response) {
        const body = await response.json() as {ok: boolean, value?: unknown, error?: {message?: string}}
        if (!body.ok) throw new Error('agent call failed (' + response.status + '): ' + body.error?.message)
        return body.value
    }

    async function get(path: string) {
        return settle(await fetch(base + path, {headers: {authorization: 'Bearer ' + TOKEN}}))
    }

    async function post(path: string, args: unknown[]) {
        return settle(await fetch(base + path, {
            method: 'POST',
            headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'},
            body: JSON.stringify(args),
        }))
    }

    // The dev bridge: call any method the module currently has, by name.
    async function callMethod(method: string, input: unknown) {
        return settle(await fetch(base + '/agent/call/' + method, {
            method: 'POST',
            headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'},
            body: JSON.stringify(input),
        }))
    }

    async function waitForSnapshot(accept: (snapshot: any) => boolean, label: string) {
        const deadline = Date.now() + WAIT_TIMEOUT_MS
        for (;;) {
            const snapshot = await get('/agent/snapshot') as any
            if (accept(snapshot)) return snapshot
            if (Date.now() > deadline) {
                throw new Error('timed out waiting for ' + label + ': ' + JSON.stringify(snapshot))
            }
            await new Promise<void>(function pause(resolvePause) {
                setTimeout(resolvePause, POLL_MS)
            })
        }
    }

    return {base, get, post, callMethod, waitForSnapshot}
}

// =====================================================================
// The scripted agent session
// =====================================================================

async function main() {
    const guideText = await readFile(
        resolve(process.cwd(), 'doc', 'prompts', 'IMPLEMENT-AGENT-HTTP-CONTROL.md'),
        'utf8',
    )
    const workDir = await mkdtemp(join(tmpdir(), 'agent-control-'))
    const moduleFile = join(workDir, 'greeting-module.js')
    await writeFile(moduleFile, moduleSource('hello'))

    const hosted = await startHost(moduleFile, guideText)
    const agent = createAgentHttpClient(hosted.port)

    try {
        // 1. The bridge builds the initial file on start.
        await agent.waitForSnapshot(s => s.active?.version == '1.0.1', 'initial build')
        const guide = await agent.get('/agent/resource/guide') as string
        assert.match(guide, /^# Agent HTTP control/m)

        // The module's own methods are the surface. Nothing declared them.
        const initialMethods = await agent.get('/agent/methods') as string[]
        assert.ok(initialMethods.includes('greet'), 'the running module reports its own methods')
        const hello = await agent.callMethod('greet', 'agent') as any
        assert.equal(hello.message, 'hello, agent')

        // 2. No token -> 401 before any work.
        const unauthorized = await fetch(agent.base + '/agent/snapshot')
        assert.equal(unauthorized.status, 401)

        // 3. A completed save hot-swaps the module.
        await writeFile(moduleFile, moduleSource('hi'))
        await agent.waitForSnapshot(s => s.active?.version == '1.0.2', 'hot swap to build 2')
        const hi = await agent.callMethod('greet', 'agent') as any
        assert.equal(hi.message, 'hi, agent')
        assert.ok(hi.bindingGeneration > hello.bindingGeneration, 'activation moved the binding generation')

        // 4. A broken edit is rejected; the active generation keeps answering.
        await writeFile(moduleFile, 'function createGreeting() {')
        const afterBroken = await agent.waitForSnapshot(
            s => s.lastBuild?.build == 3,
            'broken build attempt',
        )
        assert.equal(afterBroken.lastBuild.state, 'rejected')
        assert.ok(afterBroken.lastBuild.error != null)
        assert.equal(afterBroken.active.version, '1.0.2', 'broken edit must not replace the active version')
        const stillHi = await agent.callMethod('greet', 'agent') as any
        assert.equal(stillHi.message, 'hi, agent')

        // 5. Fixing the file recovers automatically.
        await writeFile(moduleFile, moduleSource('hola'))
        await agent.waitForSnapshot(s => s.active?.version == '1.0.4', 'recovery build')
        const hola = await agent.callMethod('greet', 'agent') as any
        assert.equal(hola.message, 'hola, agent')

        // 6. A METHOD ADDED IN THE EDITOR IS CALLABLE AS SOON AS THE FILE IS SAVED.
        //    Nothing registers it, nothing describes it, nothing publishes it.
        assert.ok(!(await agent.get('/agent/methods') as string[]).includes('stats'))
        await writeFile(moduleFile, moduleSource('hola', STATS_METHOD))
        await agent.waitForSnapshot(s => s.active?.version == '1.0.5', 'build with a new method')
        assert.ok((await agent.get('/agent/methods') as string[]).includes('stats'),
            'a new method shows up without any registration')
        const stats = await agent.callMethod('stats', {probe: 1}) as any
        assert.equal(stats.method, 'stats')
        assert.equal(stats.input.probe, 1)

        // 7. Rollback returns to the previous verified binding as a new generation,
        //    and the method that only the newer build had is gone with it.
        const rolledBack = await agent.post('/agent/control/rollback', []) as any
        assert.equal(rolledBack.version, '1.0.4')
        assert.ok(!(await agent.get('/agent/methods') as string[]).includes('stats'))
        await assert.rejects(agent.callMethod('stats', null), /no such method/,
            'a retired build must not keep serving its methods')
        const back = await agent.callMethod('greet', 'agent') as any
        assert.equal(back.message, 'hola, agent')
        assert.ok(back.bindingGeneration > hola.bindingGeneration,
            'rollback is a new generation, not history mutation')

        // 8. An explicit reload command returns the slot to the on-disk content.
        const reloaded = await agent.post('/agent/control/reload', []) as any
        assert.equal(reloaded.lastBuild.version, '1.0.6')
        assert.equal(reloaded.lastBuild.state, 'active', 'forced reload failed: ' + reloaded.lastBuild.error)
        assert.ok((await agent.get('/agent/methods') as string[]).includes('stats'))
        const again = await agent.callMethod('greet', 'agent') as any
        assert.equal(again.message, 'hola, agent')

        const health = await agent.get('/agent/health/snapshot') as any
        assert.ok(health != null && typeof health == 'object')

        console.log(JSON.stringify({
            ok: true,
            endpoint: agent.base + '/agent',
            bridge: 'demo/dev-module-bridge.ts (the same one the demo stand runs)',
            loop: 'file save -> stage -> activate -> call the method by name',
            liveMethods: await agent.get('/agent/methods'),
            finalGreeting: again.message,
            finalBindingGeneration: again.bindingGeneration,
        }, null, 2))
    } finally {
        await hosted.close()
        await rm(workDir, {recursive: true, force: true})
    }
}

void main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
