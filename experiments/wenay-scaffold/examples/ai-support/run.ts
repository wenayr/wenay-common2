import {startSupportHost} from './host'

async function main() {
    const host = await startSupportHost({port: Number(process.env.PORT ?? 0)})
    console.log('Support desk — demo, no AI model:', host.url)
    process.once('SIGINT', function stop() { host.close().catch(fatal) })
    process.once('SIGTERM', function stop() { host.close().catch(fatal) })
}
function fatal(error: unknown) {
    console.error(error)
    process.exitCode = 1
}
main().catch(fatal)
