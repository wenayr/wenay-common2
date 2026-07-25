// Oracle: createNodeIdMinter — per-node id namespaces + adopt() rescan.
// Post-failover id safety: the demo convention (per-node prefixes) promoted to a primitive.
// Disposable oracle, run through tsx.

import {createNodeIdMinter} from '../../src/Common/id-pool'

let failures = 0
function assert(cond: unknown, message: string) {
    if (!cond) { failures++; console.log('FAIL', message) }
    else console.log('PASS', message)
}

const a = createNodeIdMinter({node: 'x'})
assert(a.next('work') == 'work-x-1', 'first id is work-x-1')
assert(a.next('work') == 'work-x-2', 'second id increments')
assert(a.next('note') == 'note-x-3', 'kind changes, the counter is one line per node')
assert(a.current() == 3, 'current() reports the highest minted number')

// adopt: raise the counter past own ids; foreign namespaces and non-minter ids are ignored
const b = createNodeIdMinter({node: 'y'})
const seen = b.adopt(['work-x-7', 'work-y-3', 'my-task-y-9', 'plain', 'work-42', 'work-y-abc'])
assert(seen == 2, 'adopt sees exactly the own ids (work-y-3, my-task-y-9), got ' + seen)
assert(b.next('work') == 'work-y-10', 'counter continues past the highest own id')

// kinds may contain dashes; a dash in the node segment is rejected loudly
assert(createNodeIdMinter({node: 'z'}).adopt(['a-b-c-z-15']) == 1, 'kind may contain dashes')
let threw = false
try { createNodeIdMinter({node: 'no-dash'}) } catch { threw = true }
assert(threw, 'node with a dash is rejected')

// two nodes never collide by construction
const n1 = createNodeIdMinter({node: 'n1'})
const n2 = createNodeIdMinter({node: 'n2'})
assert(n1.next('work') != n2.next('work'), 'namespaces are disjoint by construction')

console.log(failures ? `id-minter: ${failures} FAILED` : 'id-minter: ALL GREEN')
process.exit(failures ? 1 : 0)
