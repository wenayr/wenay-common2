import assert from 'node:assert/strict'
import {mkdtemp, readdir, realpath, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createServer} from 'node:http'
import express from 'express'
import {createLocalBlobStorage, createBlobHttpRouter, createBlobArtifactStorage} from '../../src/server/blob-storage'
import {createArtifactHost} from '../../src/Common/artifact/artifact-host'
import {runOracle} from '../run-oracle'

async function main() {
    const temp = await realpath(tmpdir())
    const work = await mkdtemp(path.join(temp, 'common2-blob-'))
    const directory = path.join(work, 'objects')
    let commitAllowed = true
    const checks: string[] = []
    const storage = createLocalBlobStorage({directory, maxBytes: 32,
        authorize({context, phase, operation}) {
            checks.push(operation + ':' + phase)
            if (context != 'yes' || (phase == 'commit' && !commitAllowed)) throw new Error('denied')
        },
    })
    const app = express()
    app.use('/bytes', createBlobHttpRouter({storage, context: req => req.get('authorization') ?? ''}))
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, resolve))
    const url = 'http://localhost:' + (server.address() as {port: number}).port
    try {
        const rejected = await fetch(url + '/bytes', {method: 'POST', body: 'a'.repeat(100), headers: {authorization: 'no'}})
        assert.equal(rejected.status, 403)
        assert.deepEqual(checks, ['upload:begin'])
        checks.length = 0
        const oversized = await fetch(url + '/bytes', {method: 'POST', body: 'a'.repeat(100), headers: {authorization: 'yes'}})
        assert.equal(oversized.status, 413)
        const saved = await fetch(url + '/bytes', {method: 'POST', body: 'binary', headers: {authorization: 'yes'}})
        // the router answers {ok: true, value} with value = storage.control.upload's result
        const {value} = await saved.json() as {ok: true, value: Awaited<ReturnType<typeof storage.control.upload>>}
        assert.equal(saved.status, 200)
        assert(checks.includes('upload:commit'))
        const duplicate = await storage.control.upload('yes', Buffer.from('binary'))
        assert.equal(duplicate.id, value.id)
        assert.deepEqual(await readdir(directory), [value.id])
        const concurrent = await Promise.all(Array.from({length: 5}, () => storage.control.upload('yes', Buffer.from('binary'))))
        assert(concurrent.every(item => item.id == value.id))
        const download = await fetch(url + '/bytes/' + value.id, {headers: {authorization: 'yes'}})
        assert.equal(await download.text(), 'binary')
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
        assert.equal(download.headers.get('cache-control'), 'private, no-store')
        await assert.rejects(storage.resource.read('yes', '../escape'), /invalid blob id/)
        commitAllowed = false
        await assert.rejects(storage.control.upload('yes', Buffer.from('other')), /denied/)
        assert.deepEqual(await readdir(directory), [value.id])
        commitAllowed = true
        const invalid = createLocalBlobStorage({directory, maxBytes: 32, authorize() {}, validate() { throw new Error('validator refused') }})
        await assert.rejects(invalid.control.upload(null, Buffer.from('bad')), /validator refused/)
        assert.deepEqual(await readdir(directory), [value.id])
        const blocked = path.join(work, 'not-directory')
        await writeFile(blocked, 'file')
        await assert.rejects(createLocalBlobStorage({directory: blocked, maxBytes: 32, authorize() {}}).control.upload(null, Buffer.from('abc')))
        const artifact = createArtifactHost({storage: createBlobArtifactStorage({storage, context: () => 'yes',
            open({id}) { return {url: url + '/bytes/' + id, expiresAt: Date.now() + 1000} },
        })})
        try {
            const registered = artifact.register({owner: 'alice', storageKey: value.id,
                descriptor: {kind: 'attachment', label: 'Binary', runtime: 'download'}, retention: {class: 'persistent'}})
            const connection = artifact.connection('alice')
            const opened = await connection.fragment.open(registered.id)
            assert.equal(opened.url, url + '/bytes/' + value.id)
            connection.close()
        } finally { artifact.close() }
        console.log('PASS blob storage: auth before body/commit, limits, traversal, dedupe, IO failure, cleanup, headers and Artifact port')
    } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
        const resolved = await realpath(work)
        assert.equal(path.dirname(resolved), temp)
        assert(path.basename(resolved).startsWith('common2-blob-'))
        await rm(resolved, {recursive: true, force: true})
    }
}
runOracle(main)
