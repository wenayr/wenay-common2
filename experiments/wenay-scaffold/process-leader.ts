// Private process-test control: reuse the normal host; drain stays off the network facade.
import {runLeaderProcess} from './template/leader'
import {serviceDefinition} from './template/service'

async function main() {
    const host = await runLeaderProcess({definition: serviceDefinition})
    process.on('message', function control(message: unknown) {
        if (!message || typeof message != 'object') return
        const request = message as {type?: string, nodeId?: string}
        if (request.type == 'drain' && typeof request.nodeId == 'string') {
            host.leader.control.drain(request.nodeId)
        }
    })
}

main().catch(function fatal(error) {
    console.error(error)
    process.exitCode = 1
})
