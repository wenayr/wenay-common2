import {createListen, createListenCore, listenStore} from '../src/Common/events/Listen'

let fails = 0
const ok = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL', m) } else console.log('  OK  ', m) }

async function main() {
    console.log('\n[slim-listen] core on/off/once')
    {
        const listen = createListenCore<[number]>()
        const seen: number[] = []
        const off = listen.on(v => seen.push(v))
        listen.emit(1)
        off()
        listen.emit(2)
        listen.once(v => seen.push(v * 10))
        listen.emit(3)
        listen.emit(4)
        ok(JSON.stringify(seen) == '[1,30]', 'core delivers on, removes by off, and once fires once')
        ok(listen.count() == 0, 'core once removes itself')
    }

    console.log('\n[slim-listen] core key replacement')
    {
        const listen = createListenCore<[number]>()
        const seen: string[] = []
        listen.on(v => seen.push('a' + v), {key: 'slot'})
        listen.on(v => seen.push('b' + v), {key: 'slot'})
        listen.emit(5)
        ok(JSON.stringify(seen) == '["b5"]', 'same key replaces previous callback')
        ok(listen.count() == 1, 'key replacement keeps one live subscriber')
    }

    console.log('\n[slim-listen] full lifecycle and close hooks')
    {
        let producerClosed = 0
        let cbClosed = 0
        let streamClosed = 0
        const listen = createListen<[number]>(() => () => { producerClosed++ })
        listen.run()
        const off = listen.on(() => {}, {cbClose: () => { cbClosed++ }})
        off()
        listen.on(() => {}, {cbClose: () => { cbClosed++ }})
        listen.onClose(() => { streamClosed++ })
        listen.close()
        ok(cbClosed == 1, 'cbClose fires on full close for live subscribers only')
        ok(producerClosed == 1, 'producer cleanup fires on close')
        ok(streamClosed == 1, 'onClose fires on close')
        ok(listen.count() == 0, 'full close clears listeners')
    }

    console.log('\n[slim-listen] store once(current) waits when current is absent')
    {
        const [emit, listen] = listenStore<[number]>({current: () => undefined})
        const seen: number[] = []
        listen.once(v => seen.push(v), {current: true})
        emit(8)
        emit(9)
        ok(JSON.stringify(seen) == '[8]', 'once(current) falls back to one future event when store has no value')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })

