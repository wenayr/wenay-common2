import assert from 'node:assert/strict'
import {type Resource} from '../../../../src'
import {createDocumentStorage} from './storage'

const file: Resource.FileResource = {
    id: 'text/one', owner: 'alice', name: 'notes.txt', mime: 'text/plain; charset=utf-8', size: 4,
    state: 'uploading', createdAt: 0, updatedAt: 0,
}

function main() {
    const storage = createDocumentStorage({maxFiles: 2, maxBytes: 8})
    try {
        for (const rejected of [{...file, size: 65537}, {...file, mime: 'application/pdf'}, {...file, size: -1}]) {
            assert.throws(() => storage.port.beginUpload({file: rejected}))
            assert.deepEqual(storage.view.stats(), {files: 0, reservedBytes: 0})
        }
        assert.deepEqual(storage.port.beginUpload({file}), {path: '/bytes/text%2Fone', method: 'PUT'})
        assert.throws(() => storage.port.beginUpload({file}), /already exists/)
        assert.throws(() => storage.control.put('bob', file.id, new Uint8Array(4)), /forbidden/)
        assert.throws(() => storage.port.confirmUpload({file: {...file, owner: 'bob'}}), /forbidden/)
        assert.throws(() => storage.source.read('alice', file.id), /not confirmed/)
        storage.control.put('alice', file.id, new Uint8Array(3))
        assert.throws(() => storage.port.confirmUpload({file}), /byte size/)
        assert.deepEqual(storage.view.stats(), {files: 0, reservedBytes: 0})
        storage.port.beginUpload({file})
        storage.control.put('alice', file.id, new Uint8Array([0xff, 0xff, 0xff, 0xff]))
        assert.throws(() => storage.port.confirmUpload({file}), /encoded data/)
        assert.deepEqual(storage.view.stats(), {files: 0, reservedBytes: 0})
        storage.port.beginUpload({file})
        const bytes = new TextEncoder().encode('тё')
        storage.control.put('alice', file.id, bytes)
        bytes.fill(0)
        storage.port.confirmUpload({file})
        assert.equal(new TextDecoder().decode(storage.source.read('alice', file.id)), 'тё')
        storage.source.read('alice', file.id).fill(0)
        assert.equal(new TextDecoder().decode(storage.source.read('alice', file.id)), 'тё')
        assert.throws(() => storage.source.read('bob', file.id), /forbidden/)
        assert.throws(() => storage.control.put('alice', file.id, bytes), /overwritten/)
        assert.deepEqual(storage.port.download({file}), {path: '/bytes/text%2Fone'})
        assert.throws(() => storage.port.download({file: {...file, owner: 'bob'}}), /forbidden/)
        assert.throws(() => storage.port.beginUpload({file: {...file, id: 'large', size: 5}}), /full/)
        assert.deepEqual(storage.view.stats(), {files: 1, reservedBytes: 4})
        storage.port.beginUpload({file: {...file, id: 'two'}})
        assert.throws(() => storage.port.beginUpload({file: {...file, id: 'three', size: 0}}), /full/)
    } finally { storage.close() }
    storage.close()
    assert.deepEqual(storage.view.stats(), {files: 0, reservedBytes: 0})
    assert.throws(() => storage.source.read('alice', file.id), /closed/)
    assert.throws(() => storage.port.beginUpload({file}), /closed/)
    console.log('PASS document storage: owner isolation, UTF-8 bytes, immutable confirmed uploads, bounded admission and close')
}

main()
