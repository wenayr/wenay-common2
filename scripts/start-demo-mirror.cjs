const {spawn} = require('node:child_process')
const path = require('node:path')

function mirrorTarget() {
    const value = process.argv[2] ?? process.env.DEMO_MIRROR_OF ?? 'http://localhost:3100'
    let target
    try { target = new URL(value) }
    catch { throw new Error('demo mirror target must be an absolute http(s) URL: ' + value) }
    if (target.protocol != 'http:' && target.protocol != 'https:') {
        throw new Error('demo mirror target must use http or https: ' + value)
    }
    if (target.username || target.password || target.search || target.hash || target.pathname != '/') {
        throw new Error('demo mirror target must contain only an origin: ' + value)
    }
    return target.origin
}

function startMirror() {
    const target = mirrorTarget()
    const tsNode = path.resolve('node_modules/ts-node/dist/bin.js')
    const server = path.resolve('demo/server.ts')
    console.log('[demo:mirror] following ' + target)
    const child = spawn(process.execPath, [tsNode, '--transpile-only', server], {
        stdio: 'inherit',
        env: {...process.env, DEMO_MIRROR_OF: target},
    })
    child.once('error', function mirrorStartFailed(error) {
        console.error(error)
        process.exitCode = 1
    })
    child.once('exit', function mirrorExited(code, signal) {
        if (signal) {
            console.log('[demo:mirror] stopped by ' + signal)
            return
        }
        process.exitCode = code ?? 1
    })
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, function forwardMirrorSignal() {
            if (!child.killed) child.kill(signal)
        })
    }
}

try { startMirror() }
catch (error) {
    console.error(error)
    process.exitCode = 1
}
