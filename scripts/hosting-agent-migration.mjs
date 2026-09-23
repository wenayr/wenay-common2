// Consumer-specific migration, kept outside the library runtime.
// The verification script applies it only to its isolated copy of the hosting app.
export function migrateHostingAgent(source, kind) {
    let code = source.replaceAll('\r\n', '\n')
    function replace(from, to) {
        if (code.split(from).length != 2) throw new Error(`${kind} migration source changed: ${from.slice(0, 90)}`)
        code = code.replace(from, to)
    }
    const docker = kind == 'docker'
    replace("import {createServiceClient,", "import {createResourceScope, createReconciler} from 'wenay-common2'\nimport {createServiceClient,")
    const signature = code.split('\n').find(line => line.startsWith('export async function start'))
    replace(signature, signature + '\n    const scope = createResourceScope()\n    return scope.start(async function start(signal) {')
    replace("    const lock = await open(lockPath, 'wx')", `    const lock = await scope.resource.acquire({
        open: () => open(lockPath, 'wx'),
        async close(file) { try { await file.close() } finally { await unlink(lockPath) } },
    })`)
    replace('    const controller = new AbortController()\n', '')
    code = code.replaceAll('controller.signal', 'signal')
    code = code.replaceAll('{signal: AbortSignal.timeout(5000)}', '{signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])}')
    if (docker) {
        replace("    }).catch(async function failed(error) {await lock.close(); await unlink(lockPath); throw error})", '    })')
        replace("    const client = createServiceClient<HostingDefinition>({definition, url: deps.url, auth: {credentials: {account: deps.account, password: deps.password}}})", `    const client = createServiceClient<HostingDefinition>({definition, url: deps.url, auth: {credentials: {account: deps.account, password: deps.password}}})
    const closeClient = scope.resource.own(client.close)`)
        replace('    const gateway = createGatewayResource()', `    const gateway = createGatewayResource()
    const closeGateway = scope.resource.own(gateway.close)`)
        const start = code.indexOf('    let running = Promise.resolve()')
        const end = code.indexOf('    async function maintainRoutes()')
        code = code.slice(0, start) + `    function retry(id: string) { worker.control.retry(id, 5000) }\n\n` + code.slice(end)
        code = code.replace(/^\s+dirty = false\n/gm, '')
        const begin = code.indexOf('    async function reconcile()')
        const body = code.indexOf('                if (!client.health.state.connected) break', begin)
        const finish = code.indexOf('            } while (dirty && !signal.aborted)', body)
        let pass = code.slice(body, finish).replace('if (!client.health.state.connected) break', 'if (!client.health.state.connected) return')
            .replace('                const snapshot = client.views.assignments.store.snapshot()\n', '')
            .replace('                        dirty = false\n', '')
            .split('\n').map(line => line.startsWith('        ') ? line.slice(8) : line).join('\n')
        const ready = code.indexOf('        await client.ready()', finish)
        code = code.slice(0, begin) + `    async function reconcile(snapshot: ReturnType<typeof client.views.assignments.store.snapshot>) {\n${pass}    }\n\n` + code.slice(ready)
        replace('        off = client.views.assignments.store.listen().on(schedule)\n        schedule()\n    } catch (error) {await close(); throw error}\n    return {close, view: {account: ()=>deps.account, instance: randomUUID()}}\n}', `    const worker = createReconciler({signal, read: () => client.views.assignments.store.snapshot(), run: reconcile,
        subscribe: client.views.assignments.store.listen().on,
    })
    // Closing IO unblocks the pass; the lock remains owned until all three settle.
    scope.resource.parallel([worker.close, closeGateway, closeClient])
    scope.resource.own(worker.events.errors(function failed() {console.error('Agent reconciliation failed')}))
    worker.control.request()
    return {close: scope.close, view: {account: ()=>deps.account, instance: randomUUID()}}
    })
}`)
    } else {
        const start = code.indexOf('    let client: ReturnType')
        const end = code.indexOf('    async function reconcile()')
        code = code.slice(0, start) + code.slice(end)
        const begin = code.indexOf('    async function reconcile()')
        const body = code.indexOf('                for (const item of snapshot.operations)', begin)
        const finish = code.indexOf('            } while (dirty && !signal.aborted)', body)
        let pass = code.slice(body, finish).replace('                        dirty = false\n', '')
            .replace('                        timer ??= setTimeout(function retry() {timer = undefined; schedule()}, 5000)', "                        worker.control.retry('assignments', 5000)")
            .split('\n').map(line => line.startsWith('        ') ? line.slice(8) : line).join('\n')
        const ready = code.indexOf('        await lock.writeFile', finish)
        code = code.slice(0, begin) + `    async function reconcile(snapshot: ReturnType<typeof client.views.machineAssignments.store.snapshot>) {
        if (signal.aborted || !client.health.state.connected) return
${pass}    }\n\n` + code.slice(ready)
        replace("        client = createServiceClient({definition, url: deps.url, auth: {credentials: {account: deps.account, password: deps.password}}})", `    const client = createServiceClient({definition, url: deps.url, auth: {credentials: {account: deps.account, password: deps.password}}})
    const closeClient = scope.resource.own(client.close)`)
        replace('        off = client.views.machineAssignments.store.listen().on(schedule)\n        schedule()\n    } catch (error) {await close(); throw error}\n    return {close, view: {account: ()=>deps.account}}\n}', `    const worker = createReconciler({signal, read: () => client.views.machineAssignments.store.snapshot(), run: reconcile,
        subscribe: client.views.machineAssignments.store.listen().on,
    })
    scope.resource.parallel([worker.close, closeClient])
    scope.resource.own(worker.events.errors(function failed() {console.error('LXD reconciliation failed')}))
    worker.control.request()
    return {close: scope.close, view: {account: ()=>deps.account}}
    })
}`)
    }
    const startupTail = code.lastIndexOf('\n    }\n\n')
    code = code.slice(0, startupTail) + code.slice(startupTail)
        .replace(/^        (await |const (?:response|definition|identity)\b|if \()/gm, '    $1')
    // Indent the new ownership boundary without reformatting domain expressions.
    const rows = code.split('\n')
    const begin = rows.findIndex(line => line == '    return scope.start(async function start(signal) {')
    const end = rows.lastIndexOf('    })')
    for (let i = begin + 1; i < end; i++) if (rows[i]) rows[i] = '    ' + rows[i]
    return rows.join('\n')
}
