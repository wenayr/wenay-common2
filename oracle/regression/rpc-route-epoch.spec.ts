// Regression: a numeric method reference cached from principal P1's MAP must never resolve to a
// DIFFERENT method path after a principal switch renumbers the dispatch table for P2.
//
// Trigger: the client addresses `getUser` by the numeric index it cached under the `user`
// principal, then a reauth()/control.grant() to `admin` rebuilds the server dispatch. A dense
// renumbering makes index 0 (user.getUser) point at admin.deleteUser, so getUser(42) executes
// deleteUser(42). The fix pins each numeric ref to ONE path for the life of the connection.
import {createInProcSocketPair} from '../../src/Common/rcp/rpc-inproc'
import {createRpcServer} from '../../src/Common/rcp/rpc-server'
import {createRpcClient} from '../../src/Common/rcp/rpc-client'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + (detail ?? '')}`)
    if (!cond) failures++
}

const log: string[] = []
function facadeFor(role: string) {
    const isAdmin = role == 'admin'
    return {
        // documented Rule 3 idiom: a pruned member is null (absent from routeMap)
        admin: {deleteUser: isAdmin ? ((id: number) => { log.push('deleteUser(' + id + ')'); return 'DELETED ' + id }) : null},
        getUser: (id: number) => { log.push('getUser(' + id + ')'); return 'user ' + id },
    }
}

async function caseReauth() {
    log.length = 0
    const [c, s] = createInProcSocketPair()
    createRpcServer({
        socket: s, socketKey: 'k', object: {},
        auth: {gate: true, resolveAuth: async (t: any) => ({object: facadeFor(t), ack: {ok: true, role: t}})},
    })
    const client = createRpcClient<any>({socket: c, socketKey: 'k', token: 'user'})
    await client.ready()
    await client.func.getUser(1) // populate the numeric routeCache under the user principal
    const re = client.reauth('admin')
    // emitted with the user-principal numeric ref, resolved against the admin table
    const r = await client.func.getUser(42).catch((e: any) => 'ERR ' + e?.message)
    await re
    check('reauth: getUser(42) is not routed to deleteUser', r == 'user 42' || String(r).startsWith('ERR'),
        'got=' + r)
    check('reauth: no deleteUser side effect from a getUser call', !log.includes('deleteUser(42)'),
        'log=' + log.join(', '))
}

async function caseGrant() {
    log.length = 0
    const [c, s] = createInProcSocketPair()
    const {control} = createRpcServer({
        socket: s, socketKey: 'k', object: {},
        auth: {gate: true, resolveAuth: async (t: any) => ({object: facadeFor(t), ack: {ok: true, role: t}})},
    })
    const client = createRpcClient<any>({socket: c, socketKey: 'k', token: 'user'})
    await client.ready()
    await client.func.getUser(1)
    const p = client.func.getUser(7).catch((e: any) => 'ERR ' + e?.message)
    control.grant({object: facadeFor('admin'), ack: {ok: true, role: 'admin'}})
    const r = await p
    check('grant: getUser(7) is not routed to deleteUser', r == 'user 7' || String(r).startsWith('ERR'),
        'got=' + r)
    check('grant: no deleteUser side effect from a getUser call', !log.includes('deleteUser(7)'),
        'log=' + log.join(', '))
}

async function main() {
    await caseReauth()
    await caseGrant()
    console.log(failures == 0 ? 'ALL PASS' : `${failures} FAILED`)
    process.exit(failures == 0 ? 0 : 1)
}
main()
