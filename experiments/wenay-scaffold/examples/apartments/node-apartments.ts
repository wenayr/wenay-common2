// =====================================================================
// apartments node — the PROCESS entrypoint of one serving node
// =====================================================================
// The unchanged template process (template/node.ts runNodeProcess) around
// the apartments definition. A lock device may connect here instead of the
// leader: the per-device view line and the command corridor are the same on
// every corner. Env: SERVICE_NODE_ID, SERVICE_UPSTREAM, SERVICE_NODE_TOKEN,
// SERVICE_TOKEN_SECRET, SERVICE_PORT.

import {runNodeProcess} from '../../template/node'
import {serviceDefinition} from './service'

runNodeProcess({definition: serviceDefinition}).catch(function fatal(error) {
    console.error(error)
    process.exit(2)
})
