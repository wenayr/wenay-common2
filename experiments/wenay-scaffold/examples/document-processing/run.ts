import {startDocumentHost} from './host'

async function main() {
    const host = await startDocumentHost({port: Number(process.env.PORT ?? 0)})
    console.log('Document processing — UTF-8 only, no AI model:', host.url)
    process.once('SIGINT', function stop() { host.close().catch(failed) })
    process.once('SIGTERM', function stop() { host.close().catch(failed) })
}
function failed(error: unknown) {
    console.error(error)
    process.exitCode = 1
}
main().catch(failed)
