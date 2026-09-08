import {Listener, NormalizeTuple, listen, ListenApi} from "./Listen"

export function mapListen<TSource extends any[], TTarget extends any[]>(
    sourceListen: ListenApi<TSource>,
    transform: (...args: NormalizeTuple<TSource>) => TTarget | null,
    options?: {closeOn?: ListenApi<any>},
) {
    let unsubscribeFromSource: (() => void) | null = null
    let sourceGeneration = 0

    function disconnectSource() {
        sourceGeneration++
        const off = unsubscribeFromSource
        unsubscribeFromSource = null
        off?.()
    }

    const [emit, targetListen] = listen<TTarget>({
        event: function mappedSubscriptionChanged(type, count, api) {
            if (type == "add" && count == 1) {
                const generation = ++sourceGeneration
                api.onClose(disconnectSource)
                const sourceCallback: Listener<NormalizeTuple<TSource>> = (...args) => {
                    if (generation != sourceGeneration) return
                    const result = transform(...args)
                    if (result !== null) emit(...(result as NormalizeTuple<TTarget>))
                }
                const off = sourceListen.on(sourceCallback)
                if (generation != sourceGeneration || api.count() == 0) off()
                else unsubscribeFromSource = off
            }

            if (type == "remove" && count == 0 && unsubscribeFromSource) {
                disconnectSource()
            }
        },
        closeOn: options?.closeOn,
    })

    return [emit, targetListen] as const
}
