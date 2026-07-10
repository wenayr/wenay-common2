import {createListen, createListenCore, getListenByOn, isListenOn, listenStore} from '../src/Common/events/Listen'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function main() {
    console.log('\n[listen] core compatibility')
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
        ok(seen.join(',') == '1,30', 'core exposes on/off/once behavior')
        ok(listen.count() == 0, 'core once removes itself')
        ok(isListenOn(listen.on) && getListenByOn(listen.on) === listen, 'core on is registered for Listen identity checks')
    }
    {
        const listen = createListenCore<[number]>()
        const seen: number[] = []
        const cb = (v: number) => seen.push(v)
        const off = listen.on(cb)
        listen.emit(1)
        off()
        listen.emit(2)
        listen.on(cb)
        listen.on(cb)
        listen.on(v => seen.push(v * 10))
        listen.off(cb)
        listen.emit(3)
        ok(seen.join(',') == '1,30', 'off(cb) removes matching callbacks')
        ok(listen.count() == 1, 'off(cb) leaves unrelated subscribers')
    }

    console.log('\n[listen] store once(current) fallback')
    {
        let reads = 0
        const [emit, listen] = listenStore<[number]>({current: () => ++reads == 1 ? undefined : [7]})
        const seen: number[] = []
        listen.once(v => seen.push(v), {current: true})
        emit(8)
        emit(9)
        ok(seen.join(',') == '8', 'once(current) without current waits for one future event')
        ok(reads == 1, 'fallback does not ask current provider twice')
    }
    {
        const [_emit, listen] = listenStore<[number]>({current: () => [5]})
        const seen: number[] = []
        const off = listen.once(v => seen.push(v), {current: true})
        off()
        ok(seen.join(',') == '5' && listen.count() == 0, 'once(current) with current does not subscribe')
    }

    console.log('\n[listen] close hook parity')
    {
        const listen = createListen<[number]>(() => {})
        const order: string[] = []
        listen.onClose(() => order.push('stream1'))
        listen.on(() => {}, {cbClose: () => order.push('sub')})
        listen.onClose(() => order.push('stream2'))
        listen.close()
        ok(order.join(',') == 'stream1,sub,stream2', 'close hooks fire in insertion order like Listen.ts')
    }
    {
        const listen = createListen<[number]>(() => {})
        let closed = 0
        const off = listen.on(() => {}, {cbClose: () => closed++})
        off()
        listen.close()
        ok(closed == 0, 'off removes per-sub cbClose before close')
    }
    {
        const listen = createListen<[number]>(() => {})
        let closed = 0
        listen.on(() => {}, {key: 'slot', cbClose: () => closed++})
        listen.on(() => {}, {key: 'slot', cbClose: () => closed += 10})
        listen.close()
        ok(closed == 10, 'key replacement removes previous cbClose')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })