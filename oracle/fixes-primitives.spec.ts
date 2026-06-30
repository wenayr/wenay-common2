// DISPOSABLE ORACLE — verifies the primitive bug-fixes found while reviewing:
//   #1 PromiseArrayListen  — .all()/.allSettled() must actually RUN factory tasks (not leave thunks)
//   #2 joinListens.destroy — present + actually unsubscribes (type fix; runtime sanity here)
//   #3 joinListens         — no empty-bucket leak in `pending` after a group fires
//   #5 createIterableObject — delete on a read-only proxy must NOT throw (consistent with set())
// Run: node node_modules/ts-node/dist/bin.js --transpile-only oracle/fixes-primitives.spec.ts
import {PromiseArrayListen} from '../src/Common/async/PromiseArrayListen'
import {joinListens} from '../src/Common/events/joinListens'
import {UseListen} from '../src/Common/events/Listen'
import {createIterableObject} from '../src/Common/async/createIterableObject'

let fails = 0
function assert(cond: any, msg: string) {
    if (cond) console.log('  ok  :', msg)
    else { fails++; console.log('  FAIL:', msg) }
}

async function main() {
    // ===== #1 — factories must actually run via .all() =====
    {
        let ran = 0
        const okSeen: number[] = []
        const p = PromiseArrayListen<number>([
            () => { ran++; return 10 },          // sync factory
            async () => { ran++; return 20 },    // async factory
            Promise.resolve(30),                 // already-a-promise
        ])
        p.listenOk((data) => okSeen.push(data))
        const res = await p.promise.all()
        assert(ran === 2, '#1 both factories were invoked by .all() (ran=' + ran + ')')
        assert(p.status().ok === 3, '#1 status.ok counts all 3 tasks (ok=' + p.status().ok + ')')
        assert(okSeen.length === 3, '#1 listenOk fired for all 3 (got ' + okSeen.length + ')')
        assert(res.every(v => typeof v !== 'function'), '#1 .all() resolves values, not un-run thunks')
    }

    // ===== #1b — factory runs once across .all()+.allSettled() (memoized, no double-run) =====
    {
        let ran = 0
        const p = PromiseArrayListen<number>([() => { ran++; return 1 }])
        await p.promise.all()
        await p.promise.allSettled()
        assert(ran === 1, '#1b factory runs once across .all()+.allSettled() (ran=' + ran + ')')
    }

    // ===== #3 — pending must not retain an empty bucket after a group fires =====
    {
        const [emitA, listenA] = UseListen<[string]>()
        const [emitB, listenB] = UseListen<[string]>()
        const joined = joinListens([listenA, listenB], (d: any) => d)   // key = the value itself
        emitA('x'); emitB('x')                  // completes group "x" → fires
        assert(!joined.pending.has('x'), '#3 pending has no leftover empty bucket for fired tid')
        assert(joined.pending.size === 0, '#3 pending empty after the only group fired (size=' + joined.pending.size + ')')
    }

    // ===== #2 — destroy() present + actually unsubscribes (runtime sanity; type checked by tsc) =====
    {
        const [, listenA] = UseListen<[string]>()
        const joined = joinListens([listenA])
        assert(typeof joined.destroy === 'function', '#2 destroy() is present on the result')
        assert(listenA.count() === 1, '#2 join subscribed to the source')
        joined.destroy()
        assert(listenA.count() === 0, '#2 destroy() unsubscribed from the source')
    }

    // ===== #5 — delete on a read-only proxy must not throw =====
    {
        const store = new Map<string, number>([['a', 1]])
        const ro = createIterableObject<number>({ resolve: () => store })
        let threw = false
        try { delete (ro as any)['a'] } catch { threw = true }
        assert(!threw, '#5 delete on read-only proxy does not throw')
        assert(store.has('a'), '#5 read-only delete is a no-op (key still present)')
    }

    console.log(`\n${fails === 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails === 0 ? 0 : 1)
}
main()
