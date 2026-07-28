// Consumer smoke test: the freshly built package (file:../dist) installs as a real
// dependency and its exports map, types and runtime work through node_modules.
import {listen, BSearch, round, clone, Observe} from 'wenay-common2'
import {openFsReplayStorage} from 'wenay-common2/server'

// events
const [emit, line] = listen<[number]>()
let got = 0
line.on(v => { got = v })
emit(42)
if (got != 42) throw new Error('listen failed')

// core
if (BSearch([10, 20, 30], 20) != 1) throw new Error('BSearch failed')
if (round(1.2345, 2) != 1.23) throw new Error('round failed')
const cloned = clone({a: new Map([[1, 2]])})
if (cloned.a.get(1) != 2) throw new Error('clone failed')

// Observe store
const store = Observe.createStore<{n?: number}>({})
store.state.n = 7
if (store.state.n != 7) throw new Error('store failed')

// server subpath export resolves
if (typeof openFsReplayStorage != 'function') throw new Error('server export failed')

console.log('ok')
