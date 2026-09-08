import {runNodeProcess} from '../../template/node'
import {serviceDefinition} from './service'

runNodeProcess({definition: serviceDefinition}).catch(function fatal(error) { console.error(error); process.exit(2) })
