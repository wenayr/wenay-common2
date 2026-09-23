// Compatibility path; the implementation is owned by the public service runtime.
export * from '../../../src/service/node'
export * from '../../../src/service/definition'
export * from '../../../src/service/node-host'
import {runNodeProcess} from '../../../src/service/node-host'

if (require.main == module) {
    import('./service').then(function run({serviceDefinition}) {
        return runNodeProcess({definition: serviceDefinition})
    }).catch(function fatal(error) { console.error(error); process.exitCode = 2 })
}
