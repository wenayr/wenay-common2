import type {followReplicatedMap} from '../src/Common/Observe/replicated-map'
import type {WorkboardHost} from './workboard-host'

export const workboardStatuses = ['new', 'active', 'done'] as const

export type tWorkboardStatus = typeof workboardStatuses[number]

export type WorkboardItem = {
    id: string
    title: string
    status: tWorkboardStatus
    assignee: string | null
    revision: number
    createdAt: number
    updatedAt: number
    createdBy: string
    updatedBy: string
}

export type WorkboardState = Record<string, WorkboardItem>

export type WorkboardCreateInput = {
    requestId: string
    title: string
}

export type WorkboardRevisionInput = {
    requestId: string
    id: string
    expectedRevision: number
}

export type WorkboardRenameInput = WorkboardRevisionInput & {
    title: string
}

export type WorkboardMoveInput = WorkboardRevisionInput & {
    status: tWorkboardStatus
}

export type WorkboardAssignInput = WorkboardRevisionInput & {
    assignee: string | null
}

export type WorkboardRemoveResult = {
    id: string
    revision: number
    deleted: true
}

export type WorkboardRemote = Omit<ReturnType<WorkboardHost['connection']>['fragment'], 'state'> & {
    state: Parameters<typeof followReplicatedMap<WorkboardItem>>[0]
}
