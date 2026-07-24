import {ReplayRemote} from '../events/replay-wire'

function isMissingRpcMethod(error: any, member: string) {
    const message = error?.message
    if (typeof message != 'string' || !message.startsWith('Not a function: ')) return false
    const path = message.slice('Not a function: '.length).split(',')
    return path[path.length - 1]?.trim() == member
}

export async function readPeerRelaySeq(node: {seq?: () => number | Promise<number>} | undefined) {
    if (typeof node?.seq != 'function') return -1
    try {
        const seq = Number(await node.seq())
        return Number.isFinite(seq) ? seq : -1
    } catch (error) {
        if (isMissingRpcMethod(error, 'seq')) return -1
        throw error
    }
}

export async function readPeerRelayFrame<Z extends any[]>(remote: ReplayRemote<Z>, seq: number, hint?: unknown) {
    if (typeof remote.frame != 'function') return remote.since(seq)
    try {
        return await remote.frame(seq, hint)
    } catch (error) {
        if (isMissingRpcMethod(error, 'frame')) return remote.since(seq)
        throw error
    }
}
