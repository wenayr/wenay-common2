import type {ReplayRemote} from '../src/Common/events/replay-wire'
import type {StorePatch} from '../src/Common/Observe/store'

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

export type WorkboardRemote = {
    state: ReplayRemote<[StorePatch]>
    create: (input: WorkboardCreateInput) => WorkboardItem | Promise<WorkboardItem>
    rename: (input: WorkboardRenameInput) => WorkboardItem | Promise<WorkboardItem>
    move: (input: WorkboardMoveInput) => WorkboardItem | Promise<WorkboardItem>
    assign: (input: WorkboardAssignInput) => WorkboardItem | Promise<WorkboardItem>
    remove: (input: WorkboardRevisionInput) => WorkboardRemoveResult | Promise<WorkboardRemoveResult>
}
