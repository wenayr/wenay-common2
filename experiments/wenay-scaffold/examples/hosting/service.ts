import {createServer} from 'node:http'
import {Contract, createAsyncQueue} from '../../../../src'
import {createAppProcess, type AppProcess} from './process-resource'
import {releases, type tRelease} from './worker'

export async function createHosting(deps: {tenants: readonly string[], port?: number}) {
    const tenants = new Set(deps.tenants)
    for (const tenant of tenants) if (!/^[a-z][a-z0-9-]{0,40}$/.test(tenant)) throw new Error('use simple site names')
    const updates = new Map([...tenants].map(tenant => [tenant, createAsyncQueue()]))
    const processes: AppProcess[] = []
    let deployment = 0
    let closed = false
    let closing: Promise<void> | undefined
    const runtime = Contract.createContractRuntime({
        drainTimeoutMs: 6000,
        policy: {async acceptSession(_demand, _offer, api) {
            const health = await (api as AppProcess['api']).request('/health')
            return {accepted: !closed && health.status == 200, reason: closed ? 'hosting is closed' : 'application health check failed'}
        }},
    })

    function requireTenant(tenant: string) {
        if (closed) throw new Error('hosting is closed')
        if (!tenants.has(tenant)) throw new Error('unknown site')
    }
    function endpoint(tenant: string) {
        requireTenant(tenant)
        return url + '/sites/' + tenant + '/'
    }
    async function deployRelease(tenant: string, release: tRelease) {
        requireTenant(tenant)
        if (!Object.hasOwn(releases, release)) throw new Error('unknown bundled release')
        const generation = ++deployment
        const id = tenant + ':' + release + ':' + generation
        await runtime.control.addOffer({
            id, priority: generation,
            descriptor: {
                protocol: 1, contractId: 'site.' + tenant, contractVersion: '1.0.0',
                implementationId: release, implementationVersion: release,
            },
            async open() {
                requireTenant(tenant)
                const resource = createAppProcess({tenant, release})
                processes.push(resource)
                try { await resource.ready; requireTenant(tenant) } catch (error) { resource.close(); throw error }
                return {api: resource.api, onFail: resource.onFail, close: resource.close}
            },
        })
        requireTenant(tenant)
        await runtime.control.require({slotId: tenant, contractId: 'site.' + tenant, versionRange: '1.0.0', generation, authorityId: 'local-host', authorityEpoch: 1})
        requireTenant(tenant)
        const binding = runtime.api.binding(tenant)
        if (binding?.offerId != id) {
            await runtime.control.removeOffer(id)
            throw new Error('release rejected by health check; previous site remains active')
        }
        return {endpoint: endpoint(tenant), release, generation: binding.bindingGeneration}
    }
    async function rollbackRelease(tenant: string) {
        requireTenant(tenant)
        const previous = runtime.api.binding(tenant)
        const binding = await runtime.control.rollback(tenant)
        // Keep the rolled-back release quarantined on later tenant deployments.
        if (previous) await runtime.control.revokeOffer(previous.offerId, 'operator rollback')
        return {endpoint: endpoint(tenant), release: binding.descriptor.implementationId, generation: binding.bindingGeneration}
    }

    // A product update spans multiple runtime commands; keep each site's intent ordered.
    async function deploy(tenant: string, release: tRelease) {
        requireTenant(tenant)
        return updates.get(tenant)!.add(async function deploySite() { return deployRelease(tenant, release) })
    }
    async function rollback(tenant: string) {
        requireTenant(tenant)
        return updates.get(tenant)!.add(async function rollbackSite() { return rollbackRelease(tenant) })
    }

    // === A stable gateway leases exactly one generation for a whole HTTP request ===
    const server = createServer(async function gateway(request, response) {
        let lease: ReturnType<typeof runtime.api.acquire<AppProcess['api']>> | undefined
        try {
            if (request.method != 'GET') { response.writeHead(405); response.end('GET only'); return }
            const incoming = new URL(request.url ?? '/', 'http://localhost')
            const match = /^\/sites\/([a-z][a-z0-9-]*)\/(.*)$/.exec(incoming.pathname)
            if (!match || !tenants.has(match[1])) { response.writeHead(404); response.end('Unknown site'); return }
            lease = runtime.api.acquire<AppProcess['api']>(match[1])
            const result = await lease.api.request('/' + match[2] + incoming.search)
            response.writeHead(result.status, {
                'content-type': result.headers['content-type'] ?? 'text/plain',
                'x-release': result.headers['x-release'] ?? '',
                'x-tenant': result.headers['x-tenant'] ?? '',
            })
            response.end(result.body)
        } catch {
            response.writeHead(503)
            response.end('Site is not ready')
        } finally { lease?.release() }
    })
    let url = ''
    try {
        await new Promise<void>(function listen(resolve, reject) {
            server.once('error', reject)
            server.listen(deps.port ?? 0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address == 'string') throw new Error('missing gateway address')
        url = 'http://127.0.0.1:' + address.port
    } catch (error) { runtime.close(); throw error }
    async function shutdown() {
        await new Promise<void>(function stopGateway(resolve) { server.close(function stopped() { resolve() }) })
        runtime.close()
        await Promise.all([...updates.values()].map(queue => queue.onIdle()))
        for (const resource of processes) resource.close()
        await Promise.all(processes.map(resource => resource.done))
    }
    function close() {
        if (closing) return closing
        closed = true
        closing = shutdown()
        return closing
    }
    return {
        control: {deploy, rollback}, source: {endpoint},
        view: {status: runtime.api.explain, history: runtime.api.history, processes: () => processes.map(resource => resource.view.status())},
        events: {changed: runtime.api.changed}, close,
    }
}
export type Hosting = Awaited<ReturnType<typeof createHosting>>
