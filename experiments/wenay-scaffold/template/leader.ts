// Compatibility path; the implementation is owned by the public service runtime.
export * from '../../../src/service/leader'
export * from '../../../src/service/definition'
export * from '../../../src/service/leader-host'
import {runLeaderProcess} from '../../../src/service/leader-host'

if (require.main == module) {
    import('./service').then(function run({serviceDefinition}) {
        return runLeaderProcess({definition: serviceDefinition})
    }).catch(function fatal(error) { console.error(error); process.exitCode = 2 })
}
