import {createResourceScope, createReconciler, type ResourceScope, type Reconciler} from '../src'
import {createResourceScope as browserScope} from '../src/client'

const scope = createResourceScope() satisfies ResourceScope
const value = scope.resource.acquire({open: () => ({id: 7}), close(resource) {
    const id: number = resource.id
    // @ts-expect-error Acquisition inference must not widen to any.
    const wrong: string = resource.id
    void [id, wrong]
}}) satisfies Promise<{id: number}>
const worker = createReconciler({read: () => ({ids: ['one']}), run(snapshot, context) {
    snapshot.ids.push('two')
    // @ts-expect-error Snapshots retain their source type.
    snapshot.missing
    context.retry('operation', 100)
}}) satisfies Reconciler<{ids: string[]}>
const closing: Promise<void> = worker.close()
const shared: Promise<void> = scope.close()
void [value, closing, shared, browserScope]
