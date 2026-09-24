import {createServiceClient} from '../../template/client'
import {serviceDefinition} from './service'
import {runCheck} from '../../resources/run-check'

async function main() {
    const {startStand} = await import('./run.mjs')
    const stand = await startStand({nodes: 1})
    const customer = createServiceClient({definition: serviceDefinition, url: stand.url, auth: {credentials: {account: 'alice', password: 'alice-pass'}}})
    const worker = createServiceClient({definition: serviceDefinition, url: stand.url, auth: {credentials: {account: 'will', password: 'will-pass'}}})
    try {
        const job = await customer.commands.post('example-post', {title: 'Improve my landing page', description: 'Make the mobile layout readable', budget: 200, contact: 'alice@example.test'})
        await worker.commands.propose('example-propose', {jobId: job.id, quote: 150, note: 'I can finish it today'})
        await customer.commands.assign('example-assign', {jobId: job.id, worker: 'will'})
        await worker.commands.submit('example-submit', {jobId: job.id, result: 'Preview: mobile layout delivered'})
        console.log('Completed:', await customer.commands.accept('example-accept', {jobId: job.id}))
    } finally { customer.close(); worker.close(); await stand.close() }
}

runCheck(main)
