// REAL-SOCKET core: CALL + rich-type round-trip both ways. Port 4101.
import {startRealServer, startRealClient, makeChecker, delay} from './_rs'

const PORT = 4101

function makeObject() {
    return {
        math: {
            add: async (a: number, b: number) => a + b,
            mul: async (a: number, b: number) => a * b,
        },
        echo: async (v: any) => v,
        rich: async () => ({
            when: new Date(123456),
            map: new Map<string, number>([['a', 1], ['b', 2]]),
            set: new Set([1, 2, 3]),
            big: 9007199254740993n,
        }),
        roundtrip: async (d: Date, m: Map<string, number>) => ({d, m, n: (m.get('x') ?? 0) + 1}),
    }
}

async function main() {
    const {check, done} = makeChecker('core')
    const srv = await startRealServer({port: PORT, makeObject})
    const cli = await startRealClient<ReturnType<typeof makeObject>>({port: PORT})
    const api = cli.api

    await check('CALL math.add', () => api.math.add(5, 7), 12)
    await check('CALL math.mul', () => api.math.mul(3, 4), 12)
    await check('CALL echo primitive', () => api.echo('hello'), 'hello')
    await check('CALL echo nested obj', () => api.echo({a: [1, 2], b: {c: true}}), {a: [1, 2], b: {c: true}})

    await check('rich: Date round-trips', async () => (await api.rich()).when, new Date(123456))
    await check('rich: Map round-trips', async () => [...(await api.rich()).map], [['a', 1], ['b', 2]])
    await check('rich: Set round-trips', async () => [...(await api.rich()).set], [1, 2, 3])
    await check('rich: BigInt round-trips', async () => (await api.rich()).big === 9007199254740993n, true)

    await check('arg→server: Date+Map sent up', async () => {
        const r = await api.roundtrip(new Date(999), new Map([['x', 41]]))
        return [r.d, [...r.m], r.n]
    }, [new Date(999), [['x', 41]], 42])

    cli.close()
    await srv.close()
    process.exit(done() === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
