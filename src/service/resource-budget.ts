import {MyError} from '../toError/myThrow'
import {createRpcDeadline} from '../Common/rcp/rpc-deadline'
import type {ServiceResourceOptions} from './resource-definition'

export function resourceBudgets(options?: ServiceResourceOptions) {
    const open = options?.openTimeoutMs ?? 10_000
    const close = options?.closeTimeoutMs ?? 2000
    if (![open, close].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid resource timeout')
    return {open, close}
}
export function resourceError(code: string) {
    const messages: Record<string, string> = {
        E_RESOURCE_CLOSED: 'Resource generation is closed',
        E_RESOURCE_DENIED: 'Resource access denied',
        E_RESOURCE_OPEN: 'Resource could not be opened',
        E_RESOURCE_TIMEOUT: 'Resource operation timed out',
        E_RESOURCE_CLEANUP: 'Resource cleanup could not be confirmed',
        E_RESOURCE_UNSUPPORTED: 'Resource is not supported',
    }
    return new MyError(messages[code] ?? messages['E_RESOURCE_OPEN'], code)
}
export async function resourceWithin<T>(work: Promise<T>, ms: number, code: string, signal?: AbortSignal) {
    let timer: ReturnType<typeof createRpcDeadline> | undefined
    let off = () => {}
    try {
        return await Promise.race([work, new Promise<never>(function budget(_resolve, reject) {
            function aborted() { reject(resourceError('E_RESOURCE_CLOSED')) }
            off = () => signal?.removeEventListener('abort', aborted)
            signal?.addEventListener('abort', aborted, {once: true})
            if (signal?.aborted) aborted()
            timer = createRpcDeadline({at: Date.now() + ms, fire() { reject(resourceError(code)) }})
        })])
    } finally { timer?.cancel(); off() }
}
