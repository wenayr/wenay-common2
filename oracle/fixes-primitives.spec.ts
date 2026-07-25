// DISPOSABLE ORACLE — verifies the primitive bug-fixes found while reviewing:
//   #1 promiseProgress  — .all()/.allSettled() must actually RUN factory tasks (not leave thunks)
//   #2 joinListens.destroy — present + actually unsubscribes (type fix; runtime sanity here)
//   #3 joinListens         — no empty-bucket leak in `pending` after a group fires
//   #5 createIterableObject — delete on a read-only proxy must NOT throw (consistent with set())
// Run: npx tsx oracle/fixes-primitives.spec.ts
import {promiseProgress} from '../src/Common/async/promiseProgress'
import {joinListens} from '../src/Common/events/joinListens'
import {listen as createListenPair} from '../src/Common/events/Listen'
import {createIterableObject} from '../src/Common/async/createIterableObject'
import {StructMap} from '../src/Common/core/common'

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
        const p = promiseProgress<number>([
            () => { ran++; return 10 },          // sync factory
            async () => { ran++; return 20 },    // async factory
            Promise.resolve(30),                 // already-a-promise
        ])
        p.onOk((data) => okSeen.push(data))
        const res = await p.all()
        assert(ran === 2, '#1 both factories were invoked by .all() (ran=' + ran + ')')
        assert(p.stats().ok === 3, '#1 status.ok counts all 3 tasks (ok=' + p.stats().ok + ')')
        assert(okSeen.length === 3, '#1 listenOk fired for all 3 (got ' + okSeen.length + ')')
        assert(res.every(v => typeof v !== 'function'), '#1 .all() resolves values, not un-run thunks')
    }

    // ===== #1b — factory runs once across .all()+.allSettled() (memoized, no double-run) =====
    {
        let ran = 0
        const p = promiseProgress<number>([() => { ran++; return 1 }])
        await p.all()
        await p.allSettled()
        assert(ran === 1, '#1b factory runs once across .all()+.allSettled() (ran=' + ran + ')')
    }

    // ===== #3 — pending must not retain an empty bucket after a group fires =====
    {
        const [emitA, listenA] = createListenPair<[string]>()
        const [emitB, listenB] = createListenPair<[string]>()
        const joined = joinListens([listenA, listenB], (d: any) => d)   // key = the value itself
        emitA('x'); emitB('x')                  // completes group "x" → fires
        assert(!joined.pending.has('x'), '#3 pending has no leftover empty bucket for fired tid')
        assert(joined.pending.size === 0, '#3 pending empty after the only group fired (size=' + joined.pending.size + ')')
    }

    // ===== #2 — destroy() present + actually unsubscribes (runtime sanity; type checked by tsc) =====
    {
        const [, listenA] = createListenPair<[string]>()
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

    // ===== #6 — StructMap.has prefix miss against primitive leaf returns false =====
    {
        const m = new StructMap<readonly number[], number>()
        m.set([1], 42)
        let threw = false
        let has = true
        try { has = m.has([1, 2]) } catch { threw = true }
        assert(!threw, '#6 StructMap.has([1, 2]) does not throw when [1] stores a primitive')
        assert(has === false, '#6 StructMap.has([1, 2]) returns false for a missing composite key')
    }

    console.log(`\n${fails === 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}`)
    process.exit(fails === 0 ? 0 : 1)
}
main()
