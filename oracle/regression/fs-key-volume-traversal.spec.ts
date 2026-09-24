// saveKeyValue addresses files as <dirDef>/<path>/<key>. A caller-supplied path or key must never
// address a file outside the store: no parent hops, no roots (/, \, UNC, drive), no NUL.
import assert from 'node:assert/strict'
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {saveKeyValue} from '../../src/server/fsKeyVolume'
import {runOracle} from '../run-oracle'

let failed = 0
async function check(label: string, run: () => Promise<void>) {
    try {
        await run()
        console.log('PASS ' + label)
    } catch (error) {
        failed++
        console.log('FAIL ' + label + ': ' + ((error as Error)?.message ?? error))
    }
}

function exists(file: string) {
    return access(file).then(() => true, () => false)
}

function outcome<T>(work: Promise<T>) {
    return work.then(value => ({ok: true as const, value}), error => ({ok: false as const, error: String((error as Error)?.message ?? error)}))
}

async function main() {
    const root = await mkdtemp(path.join(tmpdir(), 'wenay-kv-'))
    const base = path.join(root, 'store')
    await mkdir(base)
    const store = saveKeyValue({dirDef: base})
    try {
        await check('get cannot read a file outside the store through a parent key', async function readOutside() {
            await writeFile(path.join(root, 'secret-read.txt'), 'secret')
            const read = await outcome(store.get({key: '../secret-read.txt'}))
            assert.equal(read.ok, false, 'read outside the store: ' + JSON.stringify(read))
            assert.match(read.ok ? '' : read.error, /key/)
        })
        await check('set cannot plant a file outside the store through a parent key', async function plantOutside() {
            await outcome(store.set({key: '../planted.txt', obj: 'planted'}))
            assert.equal(await exists(path.join(root, 'planted.txt')), false)
        })
        await check('del cannot remove a file outside the store through a parent key', async function removeOutside() {
            await writeFile(path.join(root, 'victim.txt'), 'keep me')
            await outcome(store.del({key: '../victim.txt'}))
            assert.equal(await exists(path.join(root, 'victim.txt')), true)
        })
        await check('setElMap cannot rewrite a JSON file outside the store', async function mapOutside() {
            await writeFile(path.join(root, 'config.json'), '{"admin":false}')
            await outcome(store.setElMap({key: '../config.json', keyEl: 'admin', valueEl: true}))
            assert.equal(await readFile(path.join(root, 'config.json'), 'utf8'), '{"admin":false}')
        })
        await check('a parent path cannot create directories outside the store', async function pathOutside() {
            await outcome(store.set({path: '../escape', key: 'k', obj: 'x'}))
            assert.equal(await exists(path.join(root, 'escape')), false)
        })
        await check('a backslash parent key cannot escape either', async function backslashOutside() {
            await writeFile(path.join(root, 'secret-win.txt'), 'secret')
            const read = await outcome(store.get({key: '..\\secret-win.txt'}))
            assert.equal(read.ok, false, 'read outside the store: ' + JSON.stringify(read))
        })
        await check('an absolute path cannot leave the default store root', async function absoluteOutside() {
            const target = path.join(root, 'absolute')
            await outcome(saveKeyValue({dirDef: ''}).set({path: target, key: 'k', obj: 'x'}))
            assert.equal(await exists(path.join(target, 'k')), false)
        })
        await check('NUL and drive-letter addresses are refused with the store\'s own error', async function refusedForms() {
            for (const address of [{key: 'a\0b'}, {key: 'C:secret'}, {path: 'C:/data', key: 'k'}, {path: '\\\\server\\share', key: 'k'}]) {
                const read = await outcome(store.get(address))
                assert.equal(read.ok, false, JSON.stringify(address))
                assert.match(read.ok ? '' : read.error, /saveKeyValue/, JSON.stringify(address))
            }
        })
        await check('nested relative paths and plain keys keep working', async function validAddresses() {
            await store.set({path: 'users/alice', key: 'profile.json', obj: '{"a":1}'})
            assert.equal(await store.get({path: 'users/alice', key: 'profile.json'}), '{"a":1}')
            await store.setElMap({path: 'users/alice', key: 'map.json', keyEl: 'x', valueEl: 1})
            await store.delEl({path: 'users/alice', key: 'map.json', keyEl: 'x'})
            assert.equal(await store.get({path: 'users/alice', key: 'map.json'}), '{}')
            assert.equal(await store.has({path: 'users/alice', key: 'profile.json'}), true)
            await store.del({path: 'users/alice', key: 'profile.json'})
            assert.equal(await store.has({path: 'users/alice', key: 'profile.json'}), false)
            const defaulted = saveKeyValue({dirDef: base, key: 'default.json'})
            await defaulted.set({obj: 'd'})
            assert.equal(await defaulted.get(), 'd')
        })
    } finally {
        await rm(root, {recursive: true, force: true})
    }
    if (failed) process.exitCode = 1
    else console.log('PASS saveKeyValue: every address stays inside the store')
}

runOracle(main)
