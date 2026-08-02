// =====================================================================
// Agent HTTP control self-client — the "MCP-lite" loop
// =====================================================================
// A running host exposes its control/view/health/resource facade as plain
// HTTP routes (createHttpFacadeServer), and a dev file source hot-swaps the
// module on every completed save. The client half of this file talks to the
// host ONLY through fetch + JSON — exactly like an AI agent following
// doc/prompts/IMPLEMENT-AGENT-HTTP-CONTROL.md would.

import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import express from 'express'

import {sha256Hex} from '../../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../../src/Common/dynamic/module-verifier'
import {createDynamicModuleHost} from '../../src/server/dynamic/module-host'
import {
    ModuleIsolationOpenInput,
    ModuleIsolationPort,
    ModuleIsolationSession,
} from '../../src/server/dynamic/module-isolation'
import {createModuleWorkerIsolation} from '../../src/server/dynamic/module-worker-isolation'
import {createHttpFacadeServer} from '../../src/server/httpFacadeServer'

const TOKEN = 'agent-control-self-client-token'
const SLOT_ID = 'greeting.primary'
const MODULE_ID = 'greeting.impl'
const CONTRACT_ID = 'greeting.port'
const POLL_MS = 40
const WAIT_TIMEOUT_MS = 15_000

type DynamicModuleHost = ReturnType<typeof createDynamicModuleHost>

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
// Dev file source: completed save -> stage -> activate
// =====================================================================

function createModuleFileSource(deps: {file: string, host: DynamicModuleHost, pollMs?: number}) {
    const pollMs = deps.pollMs ?? 200
    let timer: NodeJS.Timeout | null = null
    let ticking = false
    let pendingHash = ''
    let builtHash = ''
    let buildNumber = 0
    let lastBuild: {build: number, version: string, state: 'active' | 'rejected', error: string | null} | null = null
    let chain: Promise<unknown> = Promise.resolve()

    async function buildFromDisk(force: boolean) {
        const bytes = await readFile(deps.file)
        const digest = await sha256Hex(bytes)
        const contentHash = 'sha256:' + digest
        if (!force && contentHash == builtHash) return
        builtHash = contentHash
        pendingHash = ''
        // Reload means "make disk content the active binding", not "rebuild
        // the same bytes": unchanged-and-active is a no-op, and bytes the host
        // already staged (e.g. before a rollback) are discarded first because
        // the host deduplicates artifacts by content.
        const active = deps.host.view.binding(SLOT_ID)
        if (active?.descriptor.integrity == contentHash) {
            lastBuild = {
                build: buildNumber,
                version: active.descriptor.implementationVersion,
                state: 'active',
                error: null,
            }
            return
        }
        const staged = Object.values(deps.host.view.snapshot().candidates).find(candidate =>
            candidate.slotId == SLOT_ID
            && candidate.contentHash == contentHash
            && candidate.state != 'closed'
            && candidate.state != 'rejected')
        if (staged) await deps.host.control.discard(staged.candidateId, 'agent reload restage')
        buildNumber++
        const version = '1.0.' + buildNumber
        const base = {
            manifestProtocol: 1,
            moduleId: MODULE_ID,
            version,
            contentHash: 'sha256:' + digest,
            entrypoint: './index.js',
            compatibility: {
                api: {contractId: CONTRACT_ID, version: '1.0.0'},
                runtime: {name: 'node', range: '>=18'},
            },
            dependencies: [],
            capabilities: ['greeting'],
            permissions: {},
            integrity: {algorithm: 'sha256', digest, size: bytes.byteLength},
            health: {
                warmupHook: 'health.warmup',
                checkHook: 'health.check',
                timeoutMs: 500,
                failureThreshold: 2,
            },
            budget: {callTimeoutMs: 1_000, warmupTimeoutMs: 1_000, memoryMb: 64, concurrency: 4},
            signature: {
                algorithm: 'dev-key',
                keyId: 'dev-publisher',
                value: 'dev-valid-signature',
                signedFields: [] as string[],
            },
        }
        const signature = {
            ...base.signature,
            signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
        }
        try {
            const candidate = await deps.host.control.stage({
                slotId: SLOT_ID,
                priority: buildNumber,
                manifest: JSON.stringify({...base, signature}),
                bytes,
            })
            await deps.host.control.activate(candidate.candidateId)
            lastBuild = {build: buildNumber, version, state: 'active', error: null}
        } catch (error) {
            // A broken edit rejects the candidate; the active generation stays.
            lastBuild = {build: buildNumber, version, state: 'rejected', error: String(error)}
        }
    }

    function enqueueBuild(force: boolean) {
        chain = chain.then(function runBuild() {
            return buildFromDisk(force)
        })
        return chain
    }

    async function tick() {
        if (ticking) return
        ticking = true
        try {
            const bytes = await readFile(deps.file)
            const hash = 'sha256:' + await sha256Hex(bytes)
            if (hash == builtHash) return
            // A save is complete when the same content survives one more poll.
            if (hash == pendingHash) await enqueueBuild(false)
            else pendingHash = hash
        } finally {
            ticking = false
        }
    }

    return {
        control: {
            start: function start() {
                if (timer == null) timer = setInterval(function pollModuleFile() { void tick() }, pollMs)
            },
            reload: async function reload() {
                await enqueueBuild(true)
                return snapshot()
            },
            close: async function close() {
                if (timer != null) clearInterval(timer)
                timer = null
                await chain.catch(() => {})
            },
        },
        view: {snapshot},
    }

    function snapshot() {
        return {buildNumber, lastBuild, watching: timer != null}
    }
}

// =====================================================================
// Isolation decorator — so the bridge can ask what the module has right now
// =====================================================================
// The running worker already knows its own method names. Remembering the
// opened session is all it takes to list them; nothing declares anything.

function createObservedIsolation(): ModuleIsolationPort & {
    view: {session: (contentHash: string) => ModuleIsolationSession | null}
} {
    const base = createModuleWorkerIsolation({heartbeatIntervalMs: 20, heartbeatTimeoutMs: 300})
    const opened = new Map<string, ModuleIsolationSession>()
    return {
        resource: {
            open: async function openObserved(input: ModuleIsolationOpenInput) {
                const session = await base.resource.open(input)
                opened.set(input.artifact.manifest.contentHash, session)
                return session
            },
        },
        view: {session: (contentHash: string) => opened.get(contentHash) ?? null},
    }
}

// =====================================================================
// Host side: dynamic module host + agent facade over HTTP
// =====================================================================

async function startHost(moduleFile: string, guideText: string) {
    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == 'dev-valid-signature',
        policy: {publisherKeyIds: ['dev-publisher'], capabilities: ['greeting']},
    })
    const isolation = createObservedIsolation()
    const host = createDynamicModuleHost({verifier, isolation, drainTimeoutMs: 1_000})
    await host.control.require({
        slotId: SLOT_ID,
        contractId: CONTRACT_ID,
        versionRange: '1.0.0',
        generation: 1,
        authorityId: 'agent-control-self-client',
        authorityEpoch: 1,
        required: true,
    })
    const source = createModuleFileSource({file: moduleFile, host, pollMs: POLL_MS})
    const handle = host.resource.handle(SLOT_ID)

    const agentSurface = {
        control: {
            reload: function reload() {
                return source.control.reload()
            },
            rollback: async function rollback() {
                const binding = await host.control.rollback(SLOT_ID)
                return {
                    version: binding.descriptor.implementationVersion,
                    bindingGeneration: binding.bindingGeneration,
                }
            },
        },
        view: {
            snapshot: function snapshot() {
                const binding = handle.view.binding()
                return {
                    active: binding == null ? null : {
                        version: binding.descriptor.implementationVersion,
                        bindingGeneration: binding.bindingGeneration,
                    },
                    source: source.view.snapshot(),
                }
            },
        },
        health: {
            snapshot: function healthSnapshot() {
                return host.health.snapshot()
            },
        },
        resource: {
            guide: function guide() {
                return guideText
            },
        },
    }

    // What the module exposes right now, straight from the running worker.
    function liveMethods() {
        const binding = handle.view.binding()
        if (binding == null) return []
        const session = isolation.view.session(binding.descriptor.integrity)
        return [...(session?.view.snapshot().methods ?? [])].sort()
    }

    function authorizeAgent(req: express.Request, res: express.Response, next: express.NextFunction) {
        if (req.headers.authorization == 'Bearer ' + TOKEN) {
            next()
            return
        }
        res.status(401).json({ok: false, error: {message: 'Unauthorized'}})
    }

    const facadeLimits = {maxDepth: 8, maxKeys: 200, maxArgs: 4, maxArrayLen: 100, maxStringLen: 1_000_000}
    const app = express()
    createHttpFacadeServer({
        app,
        object: {view: agentSurface.view, health: agentSurface.health, resource: agentSurface.resource},
        method: 'get',
        basePath: '/agent',
        middleware: authorizeAgent,
        limits: facadeLimits,
    })
    createHttpFacadeServer({
        app,
        object: {control: agentSurface.control},
        method: 'post',
        basePath: '/agent',
        // Reject unauthorized calls before spending work parsing their bodies.
        middleware: [authorizeAgent, express.json({limit: '64kb'})],
        limits: facadeLimits,
    })

    // === Dev method bridge ===
    // The facade helper walks an object once, so it cannot follow a module that
    // gains a method at runtime. These two dynamic routes can: they ask the
    // running worker what it has and forward the call by name. No descriptors,
    // no registration, no publishing — the method IS the surface.
    app.get('/agent/methods', authorizeAgent, function listLiveMethods(_req, res) {
        res.json({ok: true, value: liveMethods()})
    })
    // strict:false — a module method takes one input, and that input may be a
    // bare string or number, not only an object or array.
    app.post('/agent/call/:method', authorizeAgent, express.json({limit: '64kb', strict: false}),
        async function callLiveMethod(req, res) {
            const method = req.params.method
            if (!liveMethods().includes(method)) {
                res.status(404).json({ok: false, error: {message: 'no such method: ' + method}})
                return
            }
            try {
                res.json({ok: true, value: await handle.call(method, req.body ?? null)})
            } catch (error) {
                res.status(500).json({ok: false, error: {message: String(error)}})
            }
        })

    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(function waitListening(resolveListening, rejectListening) {
        server.once('listening', resolveListening)
        server.once('error', rejectListening)
    })
    const address = server.address()
    if (address == null || typeof address == 'string') throw new Error('missing HTTP server address')

    source.control.start()

    async function close() {
        await source.control.close()
        await new Promise<void>(function closeServer(resolveClose) {
            server.close(function closed() {
                resolveClose()
            })
        })
        await host.close()
    }

    return {port: address.port, close}
}

// =====================================================================
// Agent side: everything below talks HTTP only
// =====================================================================

function createAgentHttpClient(port: number) {
    const base = 'http://127.0.0.1:' + port

    async function settle(response: Response) {
        const body = await response.json() as {ok: boolean, value?: unknown, error?: {message?: string}}
        if (!body.ok) throw new Error('agent call failed (' + response.status + '): ' + body.error?.message)
        return body.value
    }

    async function get(path: string, args?: unknown[]) {
        const query = args == null ? '' : '?args=' + encodeURIComponent(JSON.stringify(args))
        return settle(await fetch(base + path + query, {
            headers: {authorization: 'Bearer ' + TOKEN},
        }))
    }

    async function post(path: string, args: unknown[]) {
        return settle(await fetch(base + path, {
            method: 'POST',
            headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'},
            body: JSON.stringify(args),
        }))
    }

    async function waitForSnapshot(accept: (snapshot: any) => boolean, label: string) {
        const deadline = Date.now() + WAIT_TIMEOUT_MS
        for (;;) {
            const snapshot = await get('/agent/view/snapshot') as any
            if (accept(snapshot)) return snapshot
            if (Date.now() > deadline) {
                throw new Error('timed out waiting for ' + label + ': ' + JSON.stringify(snapshot))
            }
            await new Promise<void>(function pause(resolvePause) {
                setTimeout(resolvePause, POLL_MS)
            })
        }
    }

    // The dev bridge: call any method the module currently has, by name.
    async function callMethod(method: string, input: unknown) {
        return settle(await fetch(base + '/agent/call/' + method, {
            method: 'POST',
            headers: {authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json'},
            body: JSON.stringify(input),
        }))
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
        // 1. The watcher picks the initial file up on its own.
        await agent.waitForSnapshot(s => s.active?.version == '1.0.1', 'initial build')
        const guide = await agent.get('/agent/resource/guide') as string
        assert.match(guide, /^# Agent HTTP control/m)

        // The module's own methods are the surface. Nothing declared them.
        const initialMethods = await agent.get('/agent/methods') as string[]
        assert.ok(initialMethods.includes('greet'), 'the running module reports its own methods')
        const hello = await agent.callMethod('greet', 'agent') as any
        assert.equal(hello.message, 'hello, agent')

        // 2. No token -> 401 before any work.
        const unauthorized = await fetch(agent.base + '/agent/view/snapshot')
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
            s => s.source.lastBuild?.build == 3,
            'broken build attempt',
        )
        assert.equal(afterBroken.source.lastBuild.state, 'rejected')
        assert.ok(afterBroken.source.lastBuild.error != null)
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
