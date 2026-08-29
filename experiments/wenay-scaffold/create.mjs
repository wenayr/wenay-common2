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
        await fs.writeFile(path.join(targetDir, entry.name), raw.replaceAll('{{name}}', name), 'utf8')
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
            console.log('next: edit service.ts (the only file you own); see README.md for the import flip')
        },
        function usage(error) {
            console.error(String(error?.message ?? error))
            console.error('usage: node create.mjs <service-name> <target-directory>')
            process.exit(1)
        },
    )
}
