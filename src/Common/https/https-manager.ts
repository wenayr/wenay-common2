import {
    createCaddyfile,
    HttpsConfigInput,
    httpsPublicUrl,
    normalizeHttpsConfig,
} from './https-config'
import {createNodeHttpsResource, NodeHttpsResource} from './https-node-resource'

type HttpsManagerSettings = {
    projectRoot: string
    configPath?: string
    onLog?: (message: string) => void
}

type HttpsManagerDeps = HttpsManagerSettings & {
    resource: NodeHttpsResource
}

function createHttpsManager(deps: HttpsManagerDeps) {
    const projectRoot = deps.projectRoot
    const configPath = deps.configPath
    const log = deps.onLog || (() => undefined)
    const resource = deps.resource

    async function config(overrides: Partial<HttpsConfigInput> = {}) {
        const stored = await resource.project.loadConfig(projectRoot, configPath)
        const input = {
            ...(stored || {}),
            ...overrides,
        } as HttpsConfigInput
        return normalizeHttpsConfig(input)
    }

    async function status() {
        const state = await resource.project.state.load(projectRoot, configPath)
        const processState = await resource.caddy.process.state(state)
        let certificate
        let certificateError
        if (state && processState.running && processState.owned) {
            try {
                const currentConfig = normalizeHttpsConfig({
                    identity: state.identity,
                    backend: state.backend,
                    publicPort: state.publicPort,
                    challengePort: state.challengePort,
                    bind: state.bind,
                })
                certificate = await resource.caddy.certificate.inspect(currentConfig)
            } catch (error) {
                certificateError = (error as Error).message
            }
        }
        return {
            configured: !!state,
            running: processState.running,
            owned: processState.owned,
            pid: state?.pid,
            identity: state?.identity,
            publicUrl: state ? httpsPublicUrl(state) : undefined,
            backend: state?.backend,
            startedAt: state?.startedAt,
            certificate,
            certificateError,
            caddyErrorLog: state
                ? resource.project.paths(projectRoot, state.configPath).caddyErrPath
                : resource.project.paths(projectRoot, configPath).caddyErrPath,
        }
    }

    async function stopOperation() {
        const state = await resource.project.state.load(projectRoot, configPath)
        if (!state) {
            return {stopped: false, reason: 'not configured'}
        }
        const stopped = await resource.caddy.process.stop(state)
        await resource.project.state.remove(projectRoot, configPath)
        return {
            stopped,
            reason: stopped ? 'stopped' : 'already stopped',
        }
    }

    function stop() {
        return resource.project.withLock(projectRoot, configPath, stopOperation)
    }

    async function ensureOperation(overrides: Partial<HttpsConfigInput>) {
        const currentConfig = await config(overrides)
        await resource.network.inspectBackend(currentConfig)
        const caddyPath = await resource.caddy.executable.ensure(currentConfig.caddyPath)
        const caddyfile = createCaddyfile(currentConfig, resource.caddy.storageDir)
        const configHash = resource.caddy.config.hash(caddyfile)
        const existing = await resource.project.state.load(projectRoot, configPath)
        const processState = await resource.caddy.process.state(existing)

        if (existing && processState.running && !processState.owned) {
            throw new Error(`process ${existing.pid} no longer belongs to this HTTPS runtime`)
        }
        if (existing && processState.running && existing.configHash == configHash &&
            existing.caddyPath == caddyPath) {
            log(`Caddy is already running for ${currentConfig.identity}; checking the certificate...`)
            const certificate = await resource.caddy.certificate.wait(currentConfig, existing)
            return {
                changed: false,
                running: true,
                publicUrl: httpsPublicUrl(currentConfig),
                pid: existing.pid,
                certificate,
            }
        }
        if (existing && processState.running) {
            log('HTTPS configuration changed; stopping the previous owned Caddy process...')
            await resource.caddy.process.stop(existing)
        }
        if (existing) await resource.project.state.remove(projectRoot, configPath)

        const caddyfilePath = await resource.caddy.config.write(
            projectRoot,
            configPath,
            caddyfile,
        )
        await resource.caddy.config.validate(caddyPath, caddyfilePath, projectRoot)
        log(`Starting Caddy for ${currentConfig.identity}...`)
        const state = await resource.caddy.process.start(
            projectRoot,
            configPath,
            caddyPath,
            caddyfilePath,
            currentConfig,
            configHash,
        )
        try {
            const certificate = await resource.caddy.certificate.wait(currentConfig, state)
            return {
                changed: true,
                running: true,
                publicUrl: httpsPublicUrl(currentConfig),
                pid: state.pid,
                certificate,
            }
        } catch (error) {
            await resource.caddy.process.stop(state).catch(() => undefined)
            await resource.project.state.remove(projectRoot, configPath)
            throw error
        }
    }

    function ensure(overrides: Partial<HttpsConfigInput> = {}) {
        return resource.project.withLock(
            projectRoot,
            configPath,
            function ensureExclusive() {
                return ensureOperation(overrides)
            },
        )
    }

    async function doctor(overrides: Partial<HttpsConfigInput> = {}) {
        const checks: {
            name: string
            ok: boolean
            details: string
        }[] = []
        let currentConfig
        try {
            currentConfig = await config(overrides)
            checks.push({name: 'config', ok: true, details: 'configuration is valid'})
        } catch (error) {
            checks.push({name: 'config', ok: false, details: (error as Error).message})
            return {ok: false, checks}
        }

        const caddyPath = await resource.caddy.executable.find(currentConfig.caddyPath)
        checks.push({
            name: 'caddy',
            ok: !!caddyPath,
            details: caddyPath || `Caddy ${resource.caddy.version} will be downloaded by ensure`,
        })

        try {
            const backend = await resource.network.inspectBackend(currentConfig)
            checks.push({
                name: 'backend',
                ok: true,
                details: `${backend.host}:${backend.port} is reachable`,
            })
        } catch (error) {
            checks.push({name: 'backend', ok: false, details: (error as Error).message})
        }

        try {
            const addresses = await resource.network.resolveIdentity(currentConfig)
            checks.push({
                name: 'identity',
                ok: true,
                details: addresses.join(', '),
            })
        } catch (error) {
            checks.push({name: 'identity', ok: false, details: (error as Error).message})
        }

        const currentStatus = await status()
        checks.push({
            name: 'runtime',
            ok: !currentStatus.configured || currentStatus.running && currentStatus.owned,
            details: currentStatus.running
                ? `owned Caddy process ${currentStatus.pid} is running`
                : 'Caddy is not running',
        })
        return {
            ok: checks.every(check => check.ok),
            checks,
        }
    }

    return {
        ensure,
        status,
        doctor,
        stop,
    }
}

export function createNodeHttpsManager(deps: HttpsManagerSettings) {
    const resource = createNodeHttpsResource({
        onLog: deps.onLog,
    })
    return createHttpsManager({
        ...deps,
        resource,
    })
}

export type HttpsManager = ReturnType<typeof createNodeHttpsManager>
