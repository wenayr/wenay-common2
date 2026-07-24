import {createArtifactByteCache} from '../src/Common/artifact/artifact-cache'
import {ArtifactRecord} from '../src/Common/artifact/artifact-host'

let fails = 0
function ok(condition: unknown, message: string) {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(function wait(resolvePromise) { resolve = resolvePromise })
    return {promise, resolve}
}

function artifact(version: string): ArtifactRecord {
    return {
        id: 'artifact-' + version,
        owner: 'owner',
        descriptor: {kind: 'bytes', label: version, runtime: 'download', version},
        state: 'ready',
        retention: {class: 'persistent'},
        createdAt: 1,
        updatedAt: 1,
    }
}

async function main() {
    console.log('\n[artifact-cache] generation-safe clear and byte ownership')

    const firstFetch = deferred<Uint8Array>()
    let fetches = 0
    const cache = createArtifactByteCache({
        fetch() {
            fetches++
            return firstFetch.promise
        },
        hash: () => '1111111111111111',
    })
    const record = artifact('1111111111111111')
    const pending = cache.get(record)
    cache.clear()
    firstFetch.resolve(new Uint8Array([1, 2, 3]))
    const clearedResult = await pending
    ok(clearedResult.bytes instanceof Uint8Array && clearedResult.bytes[0] == 1,
        'a caller already awaiting the fetch still receives its verified result')
    ok(!cache.has(record.descriptor.version!) && cache.stats().entries == 0,
        'an in-flight fetch cannot repopulate a cleared generation')

    // Buffer.slice() aliases its backing memory, unlike Uint8Array.slice().
    // A Node provider must not be able to mutate a verified cache entry later.
    const source = Buffer.from([4, 5, 6])
    const owned = createArtifactByteCache({
        fetch: () => source,
        hash: () => '2222222222222222',
    })
    const ownedRecord = artifact('2222222222222222')
    const first = await owned.get(ownedRecord)
    const firstBytes = first.bytes as Uint8Array
    source[0] = 90
    firstBytes[1] = 91
    const second = await owned.get(ownedRecord)
    const secondBytes = second.bytes as Uint8Array
    secondBytes[2] = 92
    const peeked = owned.peek(ownedRecord.descriptor.version!) as Uint8Array
    ok(JSON.stringify(Array.from(peeked)) == '[4,5,6]',
        'provider, get and peek callers cannot mutate verified cached bytes')
    ok(fetches == 1 && owned.stats().hits == 1 && owned.stats().totalBytes == 3,
        'ownership copies preserve single-flight accounting and cached byte size')

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed')
    if (fails) process.exit(1)
}

main().catch(function reportFailure(error) { console.error(error); process.exit(1) })
