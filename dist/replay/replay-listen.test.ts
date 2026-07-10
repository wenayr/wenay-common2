import {replayListen, withReplayListen, ReplayEvent} from '../src/Common/events/replay-index'
import {createListen, getListenByOn, isListenOn} from '../src/Common/events/Listen'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

async function main() {
    console.log('\n[replay] live mode unchanged')
    {
        const [emit, listen] = replayListen<[number]>({history: 10})
        const seen: number[] = []
        const off = listen.on(v => seen.push(v))
        emit(1)
        emit(2)
        off()
        emit(3)
        ok(seen.join(',') == '1,2', 'plain on(cb) is live-only, off works')
        ok(listen.head() == 3, 'head counts every journaled emit')
        ok(isListenOn(listen.on) && getListenByOn(listen.on) === listen, 'decorated on is identity-registered')
    }

    console.log('\n[replay] current mode unchanged (layer 3)')
    {
        let state = 0
        const [emit0, listen] = replayListen<[number]>({history: 10, current: () => state ? [state] : undefined})
        const emit = (v: number) => { state = v; emit0(v) }
        emit(7)
        const seen: number[] = []
        listen.on(v => seen.push(v), {current: true})
        emit(8)
        ok(seen.join(',') == '7,8', 'on(cb, {current}) = keyframe + live')
        const once: number[] = []
        const offOnce = listen.once(v => once.push(v), {current: true})
        offOnce()
        ok(once.join(',') == '8' && listen.count() == 1, 'once(current) replays without subscribing')
    }

    console.log('\n[replay] since catch-up + seamless handover')
    {
        const [emit, listen] = replayListen<[string]>({history: 10})
        emit('a'); emit('b'); emit('c'); emit('d')
        const seen: string[] = []
        const seqs: number[] = []
        listen.on(v => seen.push(v), {since: 2, onSeq: s => seqs.push(s)})
        emit('e')
        ok(seen.join(',') == 'c,d,e', 'replay from seq+1 then live, no gap no dup')
        ok(seqs.join(',') == '3,4,5', 'onSeq reports the seq of every delivered event')
    }
    {
        const [emit, listen] = replayListen<[number]>({history: 10})
        emit(1)
        const seen: number[] = []
        listen.on(v => seen.push(v), {since: 0})
        emit(2)
        ok(seen.join(',') == '1,2', 'since: 0 replays the whole journal')
    }
    {
        const [emit, listen] = replayListen<[number]>({history: 10})
        emit(1); emit(2); emit(3)
        const seen: number[] = []
        listen.on(v => seen.push(v), {since: 3})
        emit(4)
        ok(seen.join(',') == '4', 'since == head: empty replay, live only')
    }

    console.log('\n[replay] re-entrant emit during replay (the subtle handover)')
    {
        const [emit, listen] = replayListen<[number]>({history: 10})
        emit(1); emit(2)
        const seen: number[] = []
        listen.on(function reentrant(v) {
            seen.push(v)
            if (v == 1) emit(100)  // emit from inside replay cb
        }, {since: 0})
        emit(3)
        ok(seen.join(',') == '1,2,100,3', 'live emit during replay queues by seq, delivered once, in order')
    }

    console.log('\n[replay] eviction fallback: fresh keyframe + line from it')
    {
        let state = 0
        const [emit0, listen] = replayListen<[number]>({history: 3, current: () => [state]})
        const emit = (v: number) => { state = v; emit0(v) }
        for (let i = 1; i <= 10; i++) emit(i)
        const seen: number[] = []
        const seqs: number[] = []
        listen.on(v => seen.push(v), {since: 2, onSeq: s => seqs.push(s)})
        emit(11)
        ok(seen.join(',') == '10,11', 'evicted seq → keyframe + live, NO backlog queue')
        ok(seqs.join(',') == '10,11', 'keyframe reports head seq → consumer can resubscribe with since')
    }
    {
        let state = 5
        const [emit0, listen] = replayListen<[number]>({history: 3, current: () => [state]})
        const emit = (v: number) => { state = v; emit0(v) }
        const seen: number[] = []
        const seqs: number[] = []
        listen.on(v => seen.push(v), {since: 999, onSeq: s => seqs.push(s)})
        ok(seen.join(',') == '5' && seqs.join(',') == '0', 'since from the future (server restarted) → keyframe fallback')
        emit(6)
        ok(seen.join(',') == '5,6', 'line is reset DOWN: live after the fallback is not muted by the stale big seq')
    }

    console.log('\n[replay] external journal (memory outside, preferred)')
    {
        const journal: ReplayEvent<[number]>[] = []
        const [emit, listen] = replayListen<[number]>({
            onJournal: ev => { journal.push(ev); if (journal.length > 3) journal.shift() },
            getSince: seq => {
                if (journal.length && seq + 1 < journal[0].seq) return undefined
                return journal.filter(ev => ev.seq > seq)
            },
        })
        for (let i = 1; i <= 5; i++) emit(i)
        const seen: number[] = []
        listen.on(v => seen.push(v), {since: 3})
        emit(6)
        ok(seen.join(',') == '4,5,6', 'external getSince drives replay, decorator owns no data')
        ok(journal.every(ev => typeof ev.ts == 'number'), 'journaled events carry ts attribute')
        ok(journal.map(ev => ev.seq).join(',') == '4,5,6', 'onJournal saw every seq, external ring evicts')
    }

    console.log('\n[replay] journal introspection (for layer B)')
    {
        const [emit, listen] = replayListen<[number]>({history: 5, now: () => 42})
        emit(10); emit(20); emit(30)
        const tail = listen.getSince(1)!
        ok(tail.map(ev => `${ev.seq}:${ev.event[0]}@${ev.ts}`).join(',') == '2:20@42,3:30@42', 'getSince returns {seq, ts, event} tail')
        ok(listen.getSince(3)!.length == 0, 'getSince(head) is empty tail')
        for (let i = 4; i <= 9; i++) emit(i)
        ok(listen.getSince(1) == undefined, 'evicted seq → undefined (caller falls back to keyframe)')
    }

    console.log('\n[replay] decorator over an externally-run base (withReplayListen direct)')
    {
        const base = createListen<[number]>(() => {})
        base.run()
        const listen = withReplayListen(base, {history: 10})
        listen.emit(1)
        listen.emit(2)
        const seen: number[] = []
        listen.on(v => seen.push(v), {since: 1})
        listen.emit(3)
        ok(seen.join(',') == '2,3', 'withReplayListen works over a plain ListenApi')
        base.emit(99)  // emitted PAST the decorator - not journaled
        ok(listen.head() == 3 && seen.join(',') == '2,3,99', 'non-journaled emit is delivered live but never journaled')
    }

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main()
