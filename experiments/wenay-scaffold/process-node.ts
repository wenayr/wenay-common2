// Private local-shutdown probe, using the exact node.leave path used by signals.
import {runNodeProcess} from './template/node'
import {serviceDefinition} from './template/service'

async function main() {
    const host = await runNodeProcess({definition: serviceDefinition})
    process.on('message', function control(message: unknown) {
        if (!message || typeof message != 'object') return
        if ((message as {type?: string}).type == 'leave') host.node.leave('planned local process shutdown')
    })
}

main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
