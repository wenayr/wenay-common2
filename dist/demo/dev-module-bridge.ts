// =====================================================================
// Development module bridge
// =====================================================================
// One watched source file becomes a live, replaceable module, and its own
// methods become HTTP routes. Save the file and the next call runs the new
// code; nothing declares, registers or publishes anything.
//
// This is a DEVELOPMENT surface. It exposes whatever methods the module
// happens to have, which is exactly why it is fast and exactly why it must
// stay behind authorization on a local interface.
//
// The staged/verify/activate lifecycle is not reimplemented here: it is the
// dynamic module host, and doc/DYNAMIC-RUNTIME.md is its canonical page.

import {readFile} from 'node:fs/promises'
import type {Express, RequestHandler} from 'express'
import express from 'express'

import {sha256Hex} from '../src/Common/artifact/artifact-hash'
import {createModuleArtifactVerifier} from '../src/Common/dynamic/module-verifier'
import {createDynamicModuleHost} from '../src/server/dynamic/module-host'
import {
    ModuleIsolationOpenInput,
    ModuleIsolationPort,
    ModuleIsolationSession,
} from '../src/server/dynamic/module-isolation'
import {createModuleWorkerIsolation} from '../src/server/dynamic/module-worker-isolation'

const DEV_SIGNATURE = 'dev-module-bridge-signature'
const DEV_KEY_ID = 'dev-module-bridge'

export type DevModuleBridgeDeps = {
    app: Pick<Express, 'get' | 'post'>
    /** Absolute path of the watched module source file. */
    file: string
    /** Route prefix, for example '/dev-module'. */
    basePath: string
    middleware?: RequestHandler | readonly RequestHandler[]
    slotId?: string
    moduleId?: string
    contractId?: string
    capability?: string
    pollMs?: number
    bodyLimit?: string
    onEvent?: (event: {type: 'built' | 'rejected', build: number, version: string, error?: string}) => void
}

type tBuild = {
    build: number
    version: string
    contentHash: string
    state: 'active' | 'rejected'
    error: string | null
}

// =====================================================================
// Isolation decorator — the session owner publishes what it opened
// =====================================================================

function createObservedIsolation(): ModuleIsolationPort & {
    view: {session: (contentHash: string) => ModuleIsolationSession | null}
} {
    const base = createModuleWorkerIsolation({heartbeatIntervalMs: 50, heartbeatTimeoutMs: 1_000})
    const opened = new Map<string, ModuleIsolationSession>()
    return {
        resource: {
            open: async function openObserved(input: ModuleIsolationOpenInput) {
                const session = await base.resource.open(input)
                // Latest session for this content wins: a rollback opens a
                // fresh worker for the same bytes.
                opened.set(input.artifact.manifest.contentHash, session)
                return session
            },
        },
        view: {session: (contentHash: string) => opened.get(contentHash) ?? null},
    }
}

// =====================================================================
// Bridge
// =====================================================================

export function createDevModuleBridge(deps: DevModuleBridgeDeps) {
    const slotId = deps.slotId ?? 'dev.primary'
    const moduleId = deps.moduleId ?? 'dev.impl'
    const contractId = deps.contractId ?? 'dev.port'
    const capability = deps.capability ?? 'dev'
    const pollMs = Math.max(20, deps.pollMs ?? 250)
    const bodyLimit = deps.bodyLimit ?? '256kb'

    const verifier = createModuleArtifactVerifier({
        verifySignature: input => input.signature == DEV_SIGNATURE,
        policy: {publisherKeyIds: [DEV_KEY_ID], capabilities: [capability]},
    })
    const isolation = createObservedIsolation()
    const host = createDynamicModuleHost({verifier, isolation, drainTimeoutMs: 2_000})
    const handle = host.resource.handle(slotId)

    let timer: NodeJS.Timeout | null = null
    let ticking = false
    let pendingHash = ''
    let builtHash = ''
    let buildNumber = 0
    let lastBuild: tBuild | null = null
    let chain: Promise<unknown> = Promise.resolve()
    let closed = false

    // === Manifest for one dev build ===

    async function manifestFor(bytes: Uint8Array, digest: string, version: string) {
        const base = {
            manifestProtocol: 1,
            moduleId,
            version,
            contentHash: 'sha256:' + digest,
            entrypoint: './index.js',
            compatibility: {
                api: {contractId, version: '1.0.0'},
                runtime: {name: 'node', range: '>=18'},
            },
            dependencies: [],
            capabilities: [capability],
            permissions: {},
            integrity: {algorithm: 'sha256', digest, size: bytes.byteLength},
            health: {
                warmupHook: 'health.warmup',
                checkHook: 'health.check',
                timeoutMs: 1_000,
                failureThreshold: 2,
            },
            budget: {callTimeoutMs: 5_000, warmupTimeoutMs: 2_000, memoryMb: 128, concurrency: 8},
            signature: {
                algorithm: 'dev-key',
                keyId: DEV_KEY_ID,
                value: DEV_SIGNATURE,
                signedFields: [] as string[],
            },
        }
        const signature = {
            ...base.signature,
            signedFields: Object.keys(base).filter(field => field != 'signature').sort(),
        }
        return JSON.stringify({...base, signature})
    }

    // === Build pipeline: disk content becomes the active binding ===

    async function buildFromDisk(force: boolean) {
        if (closed) return
        const bytes = await readFile(deps.file)
        const digest = await sha256Hex(bytes)
        const contentHash = 'sha256:' + digest
        if (!force && contentHash == builtHash) return
        builtHash = contentHash
        pendingHash = ''

        // Reload means "make disk content the active binding", not "rebuild the
        // same bytes": unchanged-and-active is a no-op, and content the host
        // already staged is discarded first because it deduplicates by content.
        const active = handle.view.binding()
        if (active?.descriptor.integrity == contentHash) {
            lastBuild = {
                build: buildNumber,
                version: active.descriptor.implementationVersion,
                contentHash,
                state: 'active',
                error: null,
            }
            return
        }
        const staged = Object.values(host.view.snapshot().candidates).find(candidate =>
            candidate.slotId == slotId
            && candidate.contentHash == contentHash
            && candidate.state != 'closed'
            && candidate.state != 'rejected')
        if (staged) await host.control.discard(staged.candidateId, 'dev bridge restage')

        buildNumber++
        const version = '1.0.' + buildNumber
        try {
            const candidate = await host.control.stage({
                slotId,
                priority: buildNumber,
                manifest: await manifestFor(bytes, digest, version),
                bytes,
            })
            await host.control.activate(candidate.candidateId)
            lastBuild = {build: buildNumber, version, contentHash, state: 'active', error: null}
            deps.onEvent?.({type: 'built', build: buildNumber, version})
        } catch (error) {
            // A broken edit rejects the candidate. The active generation is
            // untouched and keeps answering.
            const message = String(error)
            lastBuild = {build: buildNumber, version, contentHash, state: 'rejected', error: message}
            deps.onEvent?.({type: 'rejected', build: buildNumber, version, error: message})
        }
    }

    function enqueueBuild(force: boolean) {
        chain = chain.then(function runBuild() { return buildFromDisk(force) })
        return chain
    }

    async function tick() {
        if (ticking || closed) return
        ticking = true
        try {
            const bytes = await readFile(deps.file)
            const hash = 'sha256:' + await sha256Hex(bytes)
            if (hash == builtHash) return
            // A save is complete when the same content survives one more poll.
            if (hash == pendingHash) await enqueueBuild(false)
            else pendingHash = hash
        } catch {
            // A file that is missing or momentarily locked is retried next tick.
        } finally {
            ticking = false
        }
    }

    // === What the module exposes right now ===

    function methods() {
        const binding = handle.view.binding()
        if (binding == null) return []
        const session = isolation.view.session(binding.descriptor.integrity)
        return [...(session?.view.snapshot().methods ?? [])].sort()
    }

    function snapshot() {
        const binding = handle.view.binding()
        return {
            file: deps.file,
            watching: timer != null,
            active: binding == null ? null : {
                version: binding.descriptor.implementationVersion,
                bindingGeneration: binding.bindingGeneration,
                contentHash: binding.descriptor.integrity,
            },
            lastBuild,
            methods: methods(),
        }
    }

    // === Routes: list what exists, call it by name ===
    // Deliberately dynamic. createHttpFacadeServer walks an object once at
    // registration and cannot follow a module that changes shape.

    const guards = deps.middleware == undefined
        ? []
        : Array.isArray(deps.middleware) ? [...deps.middleware] : [deps.middleware as RequestHandler]

    deps.app.get(deps.basePath + '/methods', ...guards, function listDevMethods(_req, res) {
        res.json({ok: true, value: methods()})
    })
    deps.app.get(deps.basePath + '/snapshot', ...guards, function readDevSnapshot(_req, res) {
        res.json({ok: true, value: snapshot()})
    })
    deps.app.post(deps.basePath + '/call/:method', ...guards,
        // strict:false — a module method takes one input, and that input may be
        // a bare string or number, not only an object or array.
        express.json({limit: bodyLimit, strict: false}),
        async function callDevMethod(req, res) {
            const method = req.params.method
            if (!methods().includes(method)) {
                res.status(404).json({ok: false, error: {message: 'no such method: ' + method}})
                return
            }
            try {
                res.json({ok: true, value: await handle.call(method, req.body ?? null)})
            } catch (error) {
                res.status(500).json({ok: false, error: {message: String(error)}})
            }
        })

    // === Control ===

    async function start() {
        await host.control.require({
            slotId,
            contractId,
            versionRange: '1.0.0',
            generation: 1,
            authorityId: 'dev-module-bridge',
            authorityEpoch: 1,
            required: true,
        })
        await enqueueBuild(false)
        if (timer == null) {
            timer = setInterval(function pollDevModuleFile() { void tick() }, pollMs)
            timer.unref?.()
        }
        return snapshot()
    }

    async function reload() {
        await enqueueBuild(true)
        return snapshot()
    }

    async function rollback() {
        const binding = await host.control.rollback(slotId)
        // `builtHash` deliberately still points at the on-disk content, so the
        // watcher does not immediately undo the rollback. An explicit reload,
        // or the next real edit, brings disk content back.
        return {
            version: binding.descriptor.implementationVersion,
            bindingGeneration: binding.bindingGeneration,
            methods: methods(),
        }
    }

    async function close() {
        if (closed) return
        closed = true
        if (timer != null) clearInterval(timer)
        timer = null
        await chain.catch(function ignoreBuildFailure() {})
        await host.close()
    }

    return {
        control: {start, reload, rollback, close},
        view: {snapshot, methods},
        health: {snapshot: () => host.health.snapshot()},
    }
}

export type DevModuleBridge = ReturnType<typeof createDevModuleBridge>
