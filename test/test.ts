// Consumer smoke test: the freshly built package (file:../dist) installs as a real
// dependency and its exports map, types and runtime work through node_modules.
import {listen, BSearch, round, clone, Observe} from 'wenay-common2'
import {openFsReplayStorage} from 'wenay-common2/server'
import {listen as focusedListen} from 'wenay-common2/listen'
import {createRpcClient} from 'wenay-common2/rpc'
import {openFsReplayStorage as focusedFsReplayStorage} from 'wenay-common2/server/fs'
import {createTokenCodec} from 'wenay-common2/server/auth'
import {createHttpFacadeServer} from 'wenay-common2/server/http'
import {createWebhookServer} from 'wenay-common2/server/webhook'

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

// Focused package entrypoints resolve through an installed dist dependency.
for (const [name, value] of Object.entries({
    focusedListen,
    createRpcClient,
    focusedFsReplayStorage,
    createTokenCodec,
    createHttpFacadeServer,
    createWebhookServer,
})) {
    if (typeof value != 'function') throw new Error(name + ' focused export failed')
}

const beforeDebugImport = console.log
const debugConsole = require('wenay-common2/debug-console') as typeof import('wenay-common2/debug-console')
if (console.log != beforeDebugImport) throw new Error('debug-console import patched the consumer console')
if (typeof debugConsole.installConsoleCallerAnnotations != 'function') {
    throw new Error('debug-console focused export failed')
}

console.log('ok')
