import {Listener, NormalizeTuple, listen, ListenApi} from "./Listen"

export function mapListen<TSource extends any[], TTarget extends any[]>(
    sourceListen: ListenApi<TSource>,
    transform: (...args: NormalizeTuple<TSource>) => TTarget | null,
    options?: {closeOn?: ListenApi<any>},
) {
    let unsubscribeFromSource: (() => void) | null = null

    const [emit, targetListen] = listen<TTarget>({
        event: (type, count) => {
            if (type == "add" && count == 1) {
                const sourceCallback: Listener<NormalizeTuple<TSource>> = (...args) => {
                    const result = transform(...args)
                    if (result !== null) emit(...(result as NormalizeTuple<TTarget>))
                }
                unsubscribeFromSource = sourceListen.on(sourceCallback)
            }

            if (type == "remove" && count == 0 && unsubscribeFromSource) {
                unsubscribeFromSource()
                unsubscribeFromSource = null
            }
        },
        closeOn: options?.closeOn,
    })

    return [emit, targetListen] as const
}