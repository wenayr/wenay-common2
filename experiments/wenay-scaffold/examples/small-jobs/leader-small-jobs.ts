import {runLeaderProcess} from '../../template/leader'
import {DEMO_LOGINS, serviceDefinition} from './service'

runLeaderProcess({definition: serviceDefinition, mount({url}) {
    setTimeout(function logAccounts() {
        console.log(`[small-jobs] ${url()}/panel — ` + Object.entries(DEMO_LOGINS).map(([account, password]) => `${account}/${password}`).join(', '))
    }, 0)
}}).catch(function fatal(error) { console.error(error); process.exit(2) })
