import assert from 'node:assert/strict'
import {createServiceClient} from '../../template/client'
import {serviceDefinition, DEMO_LOGINS} from './service'

async function until(label: string, predicate: () => boolean) {
    const deadline = Date.now() + 10000
    while (!predicate()) {
        assert(Date.now() < deadline, 'timeout: ' + label)
        await new Promise(function wait(resolve) { setTimeout(resolve, 20) })
    }
}

async function main() {
    // The domain still refuses overwrite after a host no longer has the old receipt.
    const restored = structuredClone(serviceDefinition.initial)
    const context = {state: restored, account: 'alice', roles: ['customer'], command: 'post', requestId: 'expired-receipt'}
    const input = {title: 'Existing delivery', description: '', budget: 10, contact: 'private'}
    const original = serviceDefinition.commands.post.apply(context, input)
    restored.jobs[original.id].status = 'accepted'
    restored.jobs[original.id].result = 'preserve completed work'
    const before = structuredClone(restored)
    assert.throws(() => serviceDefinition.commands.post.apply(context, {...input, title: 'must not overwrite'}), /already exists/)
    assert.deepEqual(restored, before, 'post without a cached receipt preserves existing work')

    const {startStand} = await import('./run.mjs')
    const stand = await startStand({nodes: 1})
    const clients: ReturnType<typeof createServiceClient<typeof serviceDefinition>>[] = []
    function client(account?: keyof typeof DEMO_LOGINS) {
        const instance = createServiceClient({definition: serviceDefinition, url: stand.url,
            ...(account ? {auth: {credentials: {account, password: DEMO_LOGINS[account]}}} : {}), placement: {rng: () => 0}})
        clients.push(instance)
        return instance
    }
    try {
        const [alice, bella, will, wendy, publicReader] = [client('alice'), client('bella'), client('will'), client('wendy'), client()]
        await Promise.all(clients.map(instance => instance.ready()))
        assert.equal(alice.view.endpoint()?.nodeId, 'small-jobs-node-0', 'commands use the real serving process')
        const board = publicReader.views.board
        await board.ready
        const boardStore = board.store
        const posted = await alice.commands.post('same-post-id', {title: 'Fix a landing page', description: 'Improve mobile spacing', budget: 200, contact: 'alice-private@example.test'})
        const other = await bella.commands.post('same-post-id', {title: 'Draw a logo', description: 'Simple monochrome mark', budget: 100, contact: 'bella-private@example.test'})
        assert.notEqual(posted.id, other.id, 'same requestId in different accounts has distinct job and receipt')
        assert.match(posted.id, /^job-[a-f0-9]{64}$/)
        assert.deepEqual(await alice.commands.post('same-post-id', {title: 'ignored retry', description: '', budget: 1, contact: 'retry'}), posted)
        await until('public posts visible', () => board.store.state.jobs.length == 2)
        const wire = JSON.stringify(board.store.state)
        for (const forbidden of ['alice', 'bella', 'contact', 'customer', 'worker', 'proposals', 'result', 'same-post-id']) assert(!wire.includes(forbidden), forbidden + ' is private')
        await assert.rejects(will.commands.post('role-refused', {title: 'x', description: '', budget: 1, contact: 'x'}), /forbidden|Not a function/)
        await assert.rejects(bella.commands.cancel('foreign', {jobId: posted.id}), /only this customer/)
        await will.commands.propose('same-proposal-id', {jobId: posted.id, quote: 150, note: 'will-private-proposal'})
        await wendy.commands.propose('same-proposal-id', {jobId: posted.id, quote: 180, note: 'wendy-private-proposal'})
        const willJobs = will.views.workJobs
        const wendyJobs = wendy.views.workJobs
        const customerJobs = alice.views.customerJobs
        await Promise.all([willJobs.ready, wendyJobs.ready, customerJobs.ready])
        assert(!JSON.stringify(willJobs.store.state).includes('wendy-private-proposal'))
        assert(!JSON.stringify(willJobs.store.state).includes('alice-private'))
        await until('customer receives both proposals', () => Object.keys(customerJobs.store.state.jobs[0]?.proposals ?? {}).length == 2)
        const race = await Promise.allSettled([
            alice.commands.assign('assign-will', {jobId: posted.id, worker: 'will'}),
            alice.commands.assign('assign-wendy', {jobId: posted.id, worker: 'wendy'}),
        ])
        assert.equal(race.filter(result => result.status == 'fulfilled').length, 1, 'one assignment wins at the authority')
        const winning = race.find(result => result.status == 'fulfilled')!
        assert.equal(winning.status, 'fulfilled')
        if (winning.status != 'fulfilled') throw new Error('missing winner')
        const winner = winning.value.worker == 'will' ? will : wendy
        const loser = winner == will ? wendy : will
        const winningView = winner.views.workJobs
        const losingView = loser.views.workJobs
        await until('assigned worker receives private contact', () => winningView.store.state.jobs[0]?.contact == 'alice-private@example.test')
        assert(!JSON.stringify(losingView.store.state).includes('alice-private'))
        await assert.rejects(loser.commands.submit('cannot-submit', {jobId: posted.id, result: 'stolen'}), /assigned worker/)
        await assert.rejects(alice.commands.cancel('too-late', {jobId: posted.id}), /must be open/)
        await winner.commands.submit('delivery', {jobId: posted.id, result: 'private-result-link'})
        await alice.commands.accept('accept', {jobId: posted.id})
        await bella.commands.cancel('cancel', {jobId: other.id})
        await until('public accepted job, cancelled job hidden', () => board.store.state.jobs.length == 1 && board.store.state.jobs[0].status == 'accepted')
        assert(!JSON.stringify(board.store.state).includes('private-result-link'))
        assert(!JSON.stringify(losingView.store.state).includes('private-result-link'))
        await until('customer gets delivery', () => customerJobs.store.state.jobs[0]?.result == 'private-result-link')
        const anonymousPrivateView = await fetch(stand.url + '/api/small-jobs/views/customerJobs').then(response => response.json()) as {ok: boolean}
        assert.equal(anonymousPrivateView.ok, false, 'private result view is refused without a principal')
        const contested = await alice.commands.post('assign-cancel-race', {title: 'Race assignment and cancellation', description: '', budget: 50, contact: 'private'})
        await will.commands.propose('contest-proposal', {jobId: contested.id, quote: 30, note: 'available'})
        const assignmentOrCancellation = await Promise.allSettled([
            alice.commands.assign('contest-assign', {jobId: contested.id, worker: 'will'}),
            alice.commands.cancel('contest-cancel', {jobId: contested.id}),
        ])
        assert.equal(assignmentOrCancellation.filter(result => result.status == 'fulfilled').length, 1, 'assignment and cancellation cannot both succeed')
        await stand.restartNode(0)
        await alice.ready()
        assert.deepEqual(await alice.commands.post('same-post-id', {title: 'ignored', description: '', budget: 1, contact: 'ignored'}), posted, 'receipt survives serving node restart')
        assert.equal(board.store, boardStore)
        const fresh = await alice.commands.post('after-node-restart', {title: 'Check the new page', description: 'Review the footer', budget: 30, contact: 'alice-private@example.test'})
        await until('original board receives a new fact after serving process restart', () => board.store.state.jobs.some(job => job.id == fresh.id))
        const panel = await fetch(stand.url + '/panel')
        assert.equal(panel.status, 200)
        await panel.text()
        console.log('PASS small-jobs: real leader/node, scoped receipts and opaque IDs, proposals, single-winner assignment, delivery/acceptance, privacy, cancellation and serving-node restart')
    } finally {
        for (const instance of clients) instance.close()
        await stand.close()
    }
}

main().catch(function fatal(error) { console.error(error); process.exitCode = 1 })
