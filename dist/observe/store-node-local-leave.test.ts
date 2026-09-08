import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createAuthority} from '../src/Common/scale/scale-authority'
import {createStoreNode} from '../src/Common/Observe/store-node'

async function main() {
    const authority = createAuthority({
        line: {storeId: 'leave', originId: 'origin', initial: {counter: {value: 0}}},
        roster: {url: () => 'mem://authority', staleMs: 0},
        identity: {issue: account => account, verify: token => ({account: String(token)})},
        log() {},
    })
    authority.start()
    const nodes: ReturnType<typeof createStoreNode>[] = []
    try {
        async function open(deps: {id: string, goodbye: () => unknown, onLeave: () => void}) {
            const node = createStoreNode({
                line: {storeId: 'leave', originId: 'origin', nodeId: deps.id},
                roster: {url: () => 'mem://' + deps.id, heartbeatMs: 1000, graceMs: 80},
                upstream: () => ({
                    replica: authority.line.api.fragment,
                    control: authority.serve.nodeLink(deps.id).control,
                    register: entry => authority.roster.control.set({...entry, role: 'mirror'}),
                    heartbeat() {},
                    goodbye: deps.goodbye,
                    onFail: {on: () => () => {}},
                }),
                serve: {onConnection() {}},
                onLeave: deps.onLeave,
                log() {},
            })
            nodes.push(node)
            await node.start()
            return node
        }
        let exited = 0
        const node = await open({id: 'local',
            goodbye() { authority.roster.control.remove('local') },
            onLeave() { exited++ },
        })
        node.leave('host shutdown')
        await delay(10)
        assert.equal(authority.roster.control.get('local'), undefined, 'withdraw before the grace expires')
        assert.equal(exited, 0, 'the host stays alive during evacuation')
        await delay(110)
        assert.equal(exited, 1)
        node.leave('again')
        assert.equal(exited, 1)

        let release!: () => void
        const pending = new Promise<void>(function wait(resolve) { release = resolve })
        let pendingExit = 0
        const blocked = await open({id: 'blocked', goodbye: () => pending, onLeave() { pendingExit++ }})
        blocked.leave('unreachable control plane')
        await delay(120)
        assert.equal(pendingExit, 1, 'an unresponsive goodbye cannot prevent bounded shutdown')
        release()

        let closedExit = 0
        const closed = await open({id: 'closed', goodbye: () => pending, onLeave() { closedExit++ }})
        closed.leave('cancelled by close')
        closed.close()
        await delay(120)
        assert.equal(closedExit, 0, 'close cancels the host callback')
        console.log('PASS local leave: early withdrawal, bounded grace, terminal close')
    } finally {
        for (const node of nodes) node.close()
        authority.close()
    }
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
