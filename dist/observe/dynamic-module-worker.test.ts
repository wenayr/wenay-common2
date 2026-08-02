import {
    createModuleWorkerSession,
    MODULE_WORKER_VERIFIED_SOURCE,
    ModuleWorkerError,
    VerifiedModuleSource,
} from '../src/server/dynamic/module-worker'

let fails = 0
function ok(condition: unknown, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function fixture(source: string, id: string): VerifiedModuleSource {
    return {
        verification: MODULE_WORKER_VERIFIED_SOURCE,
        moduleId: 'fixture.module',
        version: id,
        contentHash: `sha256:${id}`,
        source,
    }
}

function createSession(source: string, id: string, overrides: Record<string, unknown> = {}) {
    return createModuleWorkerSession({
        verified: fixture(source, id),
        candidateId: 'candidate-' + id,
        bindingGeneration: 0,
        startupTimeoutMs: 500,
        heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 200,
        defaultCallTimeoutMs: 200,
        maxCallTimeoutMs: 500,
        maxConcurrentCalls: 2,
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        memoryMb: 96,
        ...overrides,
    })
}

const normalModule = String.raw`function createFixture(context) {
    return {
        echo(input, call) {
            return {
                input,
                moduleId: context.moduleId,
                version: context.version,
                bindingGeneration: call.bindingGeneration,
                correlationId: call.correlationId,
            }
        },
        fail() {
            const error = new Error('fixture exploded')
            error.code = 'E_FIXTURE'
            throw error
        },
        wait(input, call) {
            return new Promise(function waitForFixture(resolve, reject) {
                const timer = setTimeout(function finishWait() { resolve(input) }, input.ms)
                call.signal.addEventListener('abort', function abortWait() {
                    clearTimeout(timer)
                    reject(call.signal.reason)
                }, {once: true})
            })
        },
        large(input) {
            return 'x'.repeat(input.size)
        },
        useC(input) {
            return context.dependencies.call('C', 'double', input)
        },
        async optionalD(input) {
            try {
                return await context.dependencies.call('D', 'enrich', input)
            } catch (error) {
                if (error?.code == 'E_DEPENDENCY_UNAVAILABLE') {
                    return {ok: false, code: error.code, degraded: true}
                }
                throw error
            }
        },
        useUndeclared(input) {
            return context.dependencies.call('X', 'read', input)
        },
        hang() {
            while (true) {}
        },
    }
}`

async function expectCode(promise: Promise<unknown>, code: string) {
    try {
        await promise
        return false
    } catch (error) {
        return error instanceof ModuleWorkerError && error.code == code
    }
}

async function main() {
    console.log('\n[module-worker] startup, handshake, metadata and heartbeat')
    const session = createSession(normalModule, 'v1')
    const events: string[] = []
    session.events.on(function recordEvent(event) { events.push(event.type + ':' + ('state' in event ? event.state : '')) })
    await session.control.start()
    const echoed = await session.resource.call<{
        input: {value: number}
        moduleId: string
        version: string
        bindingGeneration: number
        correlationId: string
    }>('echo', {value: 3}, {correlationId: 'call-echo', bindingGeneration: 7})
    ok(echoed.input.value == 3 && echoed.moduleId == 'fixture.module' && echoed.version == 'v1',
        'verified source starts and receives immutable module metadata')
    ok(echoed.bindingGeneration == 7 && echoed.correlationId == 'call-echo',
        'active call overrides candidate generation with exact lease generation metadata')
    ok(session.view.snapshot().state == 'ready'
        && session.view.snapshot().bindingGeneration == 0
        && session.view.snapshot().memoryMb == 96
        && session.view.snapshot().methods.includes('echo'),
    'handshake preserves candidate generation zero and the configured worker memory budget')
    ok(session.health.snapshot().memoryMb == 96,
        'health exposes the memory budget mapped to worker resource limits')
    await new Promise<void>(function wait(resolve) { setTimeout(resolve, 50) })
    ok(session.health.snapshot().health == 'healthy' && events.some(event => event == 'heartbeat:'),
        'heartbeat updates the health facade and outward event line')

    console.log('\n[module-worker] dependency broker and optional degradation')
    const dependencyRequests: Array<{
        moduleId: string
        method: string
        input: unknown
        correlationId: string
        bindingGeneration: number
    }> = []
    const dependencies = createSession(normalModule, 'dependencies', {
        allowedDependencies: [
            {moduleId: 'C', apiRange: '1.0.0', required: true},
            {moduleId: 'D', apiRange: '1.0.0', required: false, degradation: 'unavailable-result'},
        ],
        dependencyCall(request: {
            moduleId: string
            method: string
            input: unknown
            correlationId: string
            bindingGeneration: number
        }) {
            dependencyRequests.push(request)
            if (request.moduleId == 'C' && request.method == 'double') return (request.input as number) * 2
            throw new Error('dependency is offline')
        },
    })
    await dependencies.control.start()
    const dependencyValue = await dependencies.resource.call<number>('useC', 4, {
        correlationId: 'call-c',
        bindingGeneration: 23,
    })
    ok(dependencyValue == 8
        && dependencyRequests[0]?.correlationId == 'call-c'
        && dependencyRequests[0]?.bindingGeneration == 23,
    'declared C resolves through the host broker with parent correlation and lease generation')
    const degraded = await dependencies.resource.call<{ok: false, code: string, degraded: true}>('optionalD', 4, {
        correlationId: 'call-d',
        bindingGeneration: 23,
    })
    ok(!degraded.ok && degraded.code == 'E_DEPENDENCY_UNAVAILABLE' && degraded.degraded,
        'optional D translates broker unavailability into a typed degraded result')
    const beforeUndeclared = dependencyRequests.length
    ok(await expectCode(
        dependencies.resource.call('useUndeclared', 4, {
            correlationId: 'call-x',
            bindingGeneration: 23,
        }),
        'E_DEPENDENCY_UNAVAILABLE',
    ) && dependencyRequests.length == beforeUndeclared,
    'undeclared dependency is denied before the host resolver is called')
    await dependencies.control.terminate('dependency test complete')

    console.log('\n[module-worker] remote errors and budgets')
    ok(await expectCode(session.resource.call('fail', null, {correlationId: 'call-fail'}), 'E_MODULE_CALL'),
        'a module exception becomes a structured remote call error')
    ok((await session.resource.call<{input: string}>('echo', 'still-alive', {correlationId: 'after-error'})).input == 'still-alive',
        'a handled module exception does not destroy the worker session')
    ok(await expectCode(
        session.resource.call('echo', 'x'.repeat(2_000), {correlationId: 'large-input'}),
        'E_INPUT_LIMIT',
    ), 'input byte budgets are enforced before dispatch')
    ok(await expectCode(
        session.resource.call('large', {size: 2_000}, {correlationId: 'large-output'}),
        'E_OUTPUT_LIMIT',
    ), 'output byte budgets are enforced inside the worker')
    ok(await expectCode(
        session.resource.call('missing', null, {correlationId: 'missing'}),
        'E_METHOD_NOT_FOUND',
    ), 'unknown methods return a typed error')
    const waitA = session.resource.call('wait', {ms: 40}, {correlationId: 'wait-a'})
    const waitB = session.resource.call('wait', {ms: 40}, {correlationId: 'wait-b'})
    ok(await expectCode(
        session.resource.call('wait', {ms: 40}, {correlationId: 'wait-overflow'}),
        'E_CONCURRENCY_LIMIT',
    ), 'concurrency is rejected at the host boundary before dispatch')
    await Promise.all([waitA, waitB])
    await session.control.terminate('normal test complete')
    ok(session.view.snapshot().state == 'closed' && session.health.snapshot().health == 'closed',
        'terminate deterministically closes the worker and health view')

    console.log('\n[module-worker] timeout contains a synchronous hang')
    const hanging = createSession(normalModule, 'hang')
    await hanging.control.start()
    ok(await expectCode(
        hanging.resource.call('hang', null, {correlationId: 'call-hang', timeoutMs: 40}),
        'E_CALL_TIMEOUT',
    ), 'call timeout rejects a synchronous infinite loop')
    await hanging.control.terminate('after timeout')
    ok(hanging.view.snapshot().state == 'failed' && hanging.health.snapshot().health == 'unhealthy',
        'timed-out worker is terminated and remains observably failed')

    console.log('\n[module-worker] AbortSignal terminates an unsafe in-flight generation')
    const aborting = createSession(normalModule, 'abort')
    await aborting.control.start()
    const abort = new AbortController()
    const abortedCall = aborting.resource.call('wait', {ms: 200}, {
        correlationId: 'call-abort',
        signal: abort.signal,
    })
    abort.abort(function uncloneableAbortReason() {})
    ok(await expectCode(abortedCall, 'E_CALL_ABORTED'),
        'AbortSignal rejects with a typed result even when its local reason is not structured-clone safe')
    await aborting.control.terminate('after abort')
    ok(aborting.view.snapshot().state == 'failed',
        'aborting dispatched work terminates the generation because arbitrary JS cannot be preempted safely')

    console.log('\n[module-worker] close races settle once')
    const racing = createSession(normalModule, 'race')
    await racing.control.start()
    const slow = racing.resource.call('wait', {ms: 200}, {correlationId: 'slow-call'})
    const firstClose = racing.control.terminate('race close')
    const secondClose = racing.control.terminate('duplicate close')
    const [callResult, firstResult, secondResult] = await Promise.allSettled([slow, firstClose, secondClose])
    ok(callResult.status == 'rejected'
        && callResult.reason instanceof ModuleWorkerError
        && callResult.reason.code == 'E_SESSION_CLOSED',
    'an in-flight call rejects exactly once when close wins')
    ok(firstResult.status == 'fulfilled' && secondResult.status == 'fulfilled',
        'concurrent terminate calls share deterministic completion')
    ok(racing.view.snapshot().state == 'closed' && racing.view.snapshot().inFlight == 0,
        'close race leaves no pending call')

    const starting = createSession(
        `async function slowStart() {
            await new Promise(function wait(resolve) { setTimeout(resolve, 200) })
            return {echo(value) { return value }}
        }`,
        'start-race',
    )
    const startingResult = starting.control.start()
    const startingClose = starting.control.terminate('close during startup')
    const [startSettled, closeSettled] = await Promise.allSettled([startingResult, startingClose])
    ok(startSettled.status == 'rejected' && closeSettled.status == 'fulfilled',
        'close during handshake rejects startup and still terminates')
    ok(starting.view.snapshot().state == 'closed', 'startup close race has one terminal state')

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
