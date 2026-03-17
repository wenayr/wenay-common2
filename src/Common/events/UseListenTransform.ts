import {funcListenCallbackBase, Listener, NormalizeTuple, UseListen} from "./Listen";

export function UseListenTransform<TSource extends any[], TTarget extends any[]>(
    sourceListen: ReturnType<typeof funcListenCallbackBase<TSource>>,
    transform: (...args: NormalizeTuple<TSource>) => TTarget | null,
    options?: {
        addListenClose?: ReturnType<typeof funcListenCallbackBase<any>>;
    }
) {
    let unsubscribeFromSource: (() => void) | null = null;

    const [emit, targetListen] = UseListen<TTarget>({
        event: (type, count, api) => {
            if (type === "add" && count === 1) {
                // Подписываемся к источнику при первом слушателе
                const sourceCallback: Listener<NormalizeTuple<TSource>> = (...args) => {
                    const result = transform(...args);
                    if (result !== null) {
                        emit(...(result as NormalizeTuple<TTarget>));
                    }
                };
                unsubscribeFromSource = sourceListen.addListen(sourceCallback);
            }

            if (type === "remove" && count === 0) {
                // Отписываемся от источника при удалении последнего слушателя
                if (unsubscribeFromSource) {
                    unsubscribeFromSource();
                    unsubscribeFromSource = null;
                }
            }
        },
        addListenClose: options?.addListenClose
    });

    return [emit, targetListen] as const;
}