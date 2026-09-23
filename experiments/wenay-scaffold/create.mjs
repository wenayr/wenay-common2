#!/usr/bin/env node
// =====================================================================
// create.mjs — instantiate the scaffold template into a target directory
// =====================================================================
// Plain node, no dependencies: copies template/* substituting {{name}}.
// Usage: node create.mjs <service-name> <target-directory>

import {promises as fs} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const templateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template')

// It becomes a package name, part of env-safe ids, and the RPC wrap key.
const NAME_SHAPE = /^[a-z][a-z0-9-]{0,63}$/

// Keep the incubator source runnable; only generated projects use package exports.
export function portableSource(raw) {
    const replacements = [
        ["../../../src/service/http-resource", 'wenay-common2/service/host'],
        ["../../../src/server/process-resource", 'wenay-common2/server/process'],
        ["../../../src/service/index'", "wenay-common2/service'"],
        ["../../../src/service'", "wenay-common2/service'"],
        ["../../../src/service/host'", "wenay-common2/service/host'"],
        ["../../../src/Common/events/listen-index'", "wenay-common2/listen'"],
        ["../../../src/Common/peer/peer-index'", "wenay-common2/peer'"],
        ["../../../src/service/definition'", "wenay-common2/service'"],
        ["../../../src/service/input-schema'", "wenay-common2/service'"],
        ["../../../src/service/descriptor'", "wenay-common2/service'"],
        ["../../../src/service/client'", "wenay-common2/service/client'"],
        ["../../../src/service/server'", "wenay-common2/service/server'"],
        ["../../../src/service/access'", "wenay-common2/service/server'"],
        ["../../../src/service/leader'", "wenay-common2/service/server'"],
        ["../../../src/service/node'", "wenay-common2/service/server'"],
        ["../../../src/service/rest'", "wenay-common2/service/server'"],
        ["../../../src/service/panel'", "wenay-common2/service/server'"],
        ["../../../src/service/config'", "wenay-common2/service/host'"],
        ["../../../src/service/leader-host'", "wenay-common2/service/host'"],
        ["../../../src/service/node-host'", "wenay-common2/service/host'"],
        ["'../../../../src'", "'wenay-common2'"],
        ["'../../../src'", "'wenay-common2'"],
        ["import type {CommandCtx} from '../../../src/Common/command/command-host'", "import type {Command} from 'wenay-common2'\ntype CommandCtx = Command.CommandCtx"],
        ["import {createAuthority} from '../../../src/Common/scale/scale-authority'", "import {Scale} from 'wenay-common2'\nconst {createAuthority} = Scale"],
        ["../../../src/Common/events/Listen", 'wenay-common2/listen'],
        ["../../../src/Common/rcp/rpc-server-auto", 'wenay-common2/rpc'],
        ["../../../src/Common/rcp/rpc-clientHub", 'wenay-common2/rpc'],
        ["../../../src/Common/Observe/store-node", 'wenay-common2/observe'],
        ["../../../src/Common/Observe/store-derive", 'wenay-common2/observe'],
        ["../../../src/Common/Observe/store-durable", 'wenay-common2/observe'],
        ["../../../src/Common/Observe/store-replay", 'wenay-common2/observe'],
        ["../../../src/Common/Observe/store'", "wenay-common2/observe'"],
        ["../../../src/server/httpFacadeServer", 'wenay-common2/server/http'],
        ["../../../src/server/httpFacadeOpenApi", 'wenay-common2/server/http'],
        ["../../../src/Common/rcp/rpc-limits", 'wenay-common2/rpc'],
        ["../../../src/server/auth-token", 'wenay-common2/server/auth'],
        ["../../../src/server/fsReplayStorage", 'wenay-common2/server/fs'],
        ["../../../src/Common/rcp/rpc-client'", "wenay-common2/rpc'"],
        ["../../../src/Common/Observe/store-follower", 'wenay-common2/observe'],
        ["../../../src/Common/Observe/store-replica-set", 'wenay-common2/observe'],
        ["../../../src/Common/Observe/node-directory", 'wenay-common2/observe'],
        ["../../../src/Common/funcTimeWait", 'wenay-common2'],
        ["../../../src/Common/events/replay-history", 'wenay-common2/replay'],
        // leader.ts already imports the Scale namespace (the createAuthority mapping above): the type rides on it
        ["import type {ScaleDurableLine} from '../../../src/Common/scale/scale-authority'", "type ScaleDurableLine = Scale.ScaleDurableLine"],
        ["import('./service')", "import('./service.js')"],
    ]
    let result = raw.replace(/\/\/ TODO\(graduation\):[^\r\n]*\r?\n\/\/ entrypoints[^\r\n]*\r?\n\/\/ template graduates[^\r\n]*\r?\n/g, '')
    for (const [from, to] of replacements) result = result.replaceAll(from, to)
    if (/from\s+['"][^'"]*src\//.test(result)) throw new Error('template import has no public package mapping')
    return result
}

export async function instantiate({name, target}) {
    if (!NAME_SHAPE.test(String(name ?? ''))) {
        throw new Error('service name must match ' + NAME_SHAPE + ' (example: rental-service)')
    }
    const targetDir = path.resolve(String(target ?? ''))
    await fs.mkdir(targetDir, {recursive: true})
    const existing = await fs.readdir(targetDir)
    if (existing.length > 0) throw new Error('target directory is not empty: ' + targetDir)

    const files = []
    for (const entry of await fs.readdir(templateDir, {withFileTypes: true})) {
        if (!entry.isFile()) continue
        const raw = await fs.readFile(path.join(templateDir, entry.name), 'utf8')
        let output = entry.name.endsWith('.ts') ? portableSource(raw) : raw
        if (entry.name == 'tsconfig.json') {
            const config = JSON.parse(output)
            config.compilerOptions.module = 'Node16'
            config.compilerOptions.moduleResolution = 'Node16'
            config.compilerOptions.skipLibCheck = false
            config.compilerOptions.lib = ['esnext', 'dom']
            output = JSON.stringify(config, null, 4) + '\n'
        }
        await fs.writeFile(path.join(targetDir, entry.name), output.replaceAll('{{name}}', name), 'utf8')
        files.push(entry.name)
    }
    return {name, targetDir, files}
}

// Runnable CLI + importable module (self-check calls instantiate in-process).
if (process.argv[1] && path.resolve(process.argv[1]) == path.resolve(fileURLToPath(import.meta.url))) {
    const [name, target] = process.argv.slice(2)
    instantiate({name, target}).then(
        function report(result) {
            console.log(`created ${result.name} in ${result.targetDir}`)
            for (const file of result.files) console.log('  ' + file)
            console.log('next: npm install, npm run typecheck, npm run leader; see README.md and edit service.ts')
        },
        function usage(error) {
            console.error(String(error?.message ?? error))
            console.error('usage: node create.mjs <service-name> <target-directory>')
            process.exit(1)
        },
    )
}
