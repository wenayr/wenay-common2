import {listen as createListenPair, listenStore} from '../src/Common/events/Listen'

let fails = 0
const ok = (c: any, m: string) => { if (!c) { fails++; console.log('  FAIL', m) } else console.log('  OK  ', m) }

async function main() {
    console.log('\n[listen-store] base listen is a pure event list')
    {
        const [emit, listen] = createListenPair<[number]>()
        emit(1)
        let got = 0
        ;(listen.on as any)((v: number) => { got = v }, {current: true})
        ok(got == 0, 'base listen ignores current and stores no value')
    }

    console.log('\n[listen-store] listenStore reads external store reference')
    {
        const box = {value: 1}
        const [emit, listen] = listenStore<[number]>({current: () => [box.value]})
        emit(99)
        let got = 0
        listen.on(v => { got = v }, {current: true})
        ok(got == 1, 'current:true reads store provider, not emitted args')
        box.value = 9
        got = 0
        listen.once(v => { got = v }, {current: true})
        ok(got == 9, 'once(current) reads changed external value')
    }

    console.log('\n[listen-store] per-subscription getter overrides wrapper provider')
    {
        const box = {value: 1}
        const [emit, listen] = listenStore<[number]>({current: () => [box.value]})
        emit(7)
        let got = 0
        listen.on(v => { got = v }, {current: () => [42]})
        ok(got == 42, 'per-call current getter is used for that subscriber')
    }

    console.log('\n[listen-store] normal events still flow through the wrapper')
    {
        const box = {value: 1}
        const [emit, listen] = listenStore<[number]>({current: () => [box.value]})
        const seen: number[] = []
        const off = listen.on(v => seen.push(v))
        emit(5)
        off()
        emit(6)
        ok(JSON.stringify(seen) == '[5]', 'wrapper delegates event delivery and off() to base listen')
    }

    console.log('\n[listen-store] failed current delivery removes the subscription')
    {
        const providerError = new Error('current provider failed')
        const [, listen] = listenStore<[number]>({
            current: function readCurrent() {
                throw providerError
            },
        })
        let caught: unknown
        try {
            listen.on(function ignoreCurrent() {}, {current: true})
        } catch (error) {
            caught = error
        }
        ok(caught == providerError, 'provider error is rethrown synchronously unchanged')
        ok(listen.count() == 0, 'provider error removes the registered callback')
    }
    {
        const callbackError = new Error('current callback failed')
        const [, listen] = listenStore<[number]>({current: () => [1]})
        let caught: unknown
        try {
            listen.on(function failCurrentCallback() {
                throw callbackError
            }, {current: true})
        } catch (error) {
            caught = error
        }
        ok(caught == callbackError, 'callback error is rethrown synchronously unchanged')
        ok(listen.count() == 0, 'callback error removes the registered callback')
    }

    console.log(`\n${fails == 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails == 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
