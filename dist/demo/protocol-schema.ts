import type {RpcOpt} from '../src/Common/rcp/rpc-caps'
import type {WorkboardItem} from './workboard-contract'

function workboardItem(assignee: string | null): WorkboardItem {
    return {
        id: 'schema-item',
        title: 'schema title',
        status: 'new',
        assignee,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'schema-user',
        updatedBy: 'schema-user',
    }
}

const itemWithoutAssignee = workboardItem(null)
const itemWithAssignee = workboardItem('schema-user')

/**
 * Runtime representatives contain no business seed data. Only their field/type
 * layouts are sent in the v2 PROBE/ACK prelude.
 */
export const demoRpcOpt = {
    binary: {
        predeclared: [
            itemWithoutAssignee,
            itemWithAssignee,
            {
                seq: 1,
                ts: 1,
                event: [[{
                    path: ['schema-item'],
                    exists: true,
                    value: itemWithoutAssignee,
                }]],
            },
        ],
    },
} satisfies RpcOpt
