import {createHosting} from './service'

async function main() {
    const hosting = await createHosting({tenants: ['my-site']})
    try {
        const site = await hosting.control.deploy('my-site', 'v1')
        console.log('Deployed:', site.endpoint, (await fetch(site.endpoint)).headers.get('x-release'))
        await hosting.control.deploy('my-site', 'v2')
        console.log('Updated:', site.endpoint, (await fetch(site.endpoint)).headers.get('x-release'))
        await hosting.control.rollback('my-site')
        console.log('Rolled back:', site.endpoint, (await fetch(site.endpoint)).headers.get('x-release'))
    } finally { await hosting.close() }
}

main().catch(function fatal(error) { console.error(error); process.exitCode = 1 })
