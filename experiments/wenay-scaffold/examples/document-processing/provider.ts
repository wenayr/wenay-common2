import {setTimeout as delay} from 'node:timers/promises'
import type {Resource} from '../../../../src'
import type {DocumentStorage} from './storage'

export function createTextProcessor(deps: {storage: DocumentStorage, stepMs?: number}) {
    const pending = new Set<AbortController>()
    async function run(context: Parameters<Resource.FileJobRunner['run']>[0]) {
        const controller = new AbortController()
        pending.add(controller)
        try {
            context.report({progress: 0.2, message: 'Reading confirmed UTF-8 bytes'})
            await delay(deps.stepMs ?? 250, undefined, {signal: controller.signal})
            if (context.cancelled()) return
            const bytes = deps.storage.source.read(context.file.owner, context.file.id)
            const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
            context.report({progress: 0.65, message: 'Counting words and lines — no AI model'})
            await delay(deps.stepMs ?? 250, undefined, {signal: controller.signal})
            if (context.cancelled()) return
            return {result: {
                method: 'Deterministic UTF-8 text processing; no AI model',
                bytes: bytes.length, words: text.trim() ? text.trim().split(/\s+/u).length : 0,
                lines: text ? text.split(/\r\n|\r|\n/).length : 0, excerpt: text.slice(0, 200),
            }}
        } catch (error) {
            if (!controller.signal.aborted) throw error
        } finally { pending.delete(controller) }
    }
    function close() { for (const controller of pending) controller.abort() }
    return {runner: {run} satisfies Resource.FileJobRunner, close}
}
