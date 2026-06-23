export type Listener<T extends any[]> = (...r: T) => void

/** Нормализация: если T уже кортеж — оставляем, иначе оборачиваем в [T] */
export type NormalizeTuple<T> = T extends any[] ? T : [T]

type key = string
export function funcListenCallbackBase<T>(b: (e: Listener<NormalizeTuple<T>>) => (void | (() => void)),
                                                            {fast = true, event, addListenClose}: {
                                                            event?: (type: "add" | "remove", count: number, api: ReturnType<typeof funcListenCallbackBase<T>>) => void,
                                                            fast?: boolean,
                                                            addListenClose?: ReturnType<typeof funcListenCallbackBase<any>>
                                                        } = {}
) {
    type Z = NormalizeTuple<T>
    type cbClose = ()=>void
    const obj = new Map<Listener<Z>|key, Listener<Z>>()
    // evClose/sinh are LAZY: allocated only when a cbClose is actually used.
    // Most subscribers pass no cbClose, so these stay null — no empty Maps per Listen.
    let evClose: Map<cbClose|Listener<Z>|key, cbClose> | null = null
    let sinh: Map<cbClose, Listener<Z>> | null = null
    let a: Listener<Z> | null = (...e) => {obj.forEach(z => z(...e))}
    let close: (() => void) | null | undefined= null
    let cached: Listener<Z>[] | null = null
    let closeUnsubscribe: (() => void) | null = null

    const getArr = () => cached ?? (cached = Array.from(obj.values()))

    const rebuild = () => {
        cached = null
        const size = obj.size
        if (size === 0) { a = null; return }
        if (size === 1) { a = obj.values().next().value!; return }
        if (size === 2) {
            const [a0, a1] = getArr()
            a = ((...e) => { a0(...e); a1(...e) }) as Listener<Z>
            return
        }
        a = ((...e) => {
            const ar = getArr()
            for (let i = 0, len = ar.length; i < len; i++) ar[i](...e)
        }) as Listener<Z>
    }

    const func: Listener<Z> = (...e) => { a?.(...e) }

    // Реальная логика снятия одной подписки по ключу. Внутренняя, поэтому off()
    // (то, что отдаёт addListen) и deprecated-метод removeListen бьют в неё оба —
    // off() не «зажигает» deprecation-предупреждение на собственную реализацию.
    function removeKey(k: Listener<Z> | null | key) {
        obj.delete(k!)
        const e = evClose?.get(k!)
        if (fast) rebuild()
        evClose?.delete(k!)
        if (e) {
            evClose?.delete(e)
            sinh?.delete(e)
        }
        event?.("remove", obj.size, api)
    }

    const run = () => {
        close = (b(func) ?? (() => {})) as (() => void)
        
        // Подписываемся на событие закрытия
        if (addListenClose && !closeUnsubscribe) {
            closeUnsubscribe = addListenClose.addListen(() => {
                api.close()
            })
        }
    }

    const api = {
        func,
        isRun: () => close !== null,
        run,
        close: () => {
            close?.()
            close = null
            obj.clear()
            if (fast) rebuild()
            sinh = null
            if (evClose) { evClose.forEach(cb => cb()); evClose = null }
            
            // Отписываемся от события закрытия
            if (closeUnsubscribe) {
                closeUnsubscribe()
                closeUnsubscribe = null
            }
        },
        eventClose: (cb: ()=>void) => {
            evClose = evClose ?? new Map()
            evClose.set(cb, cb)
            return () => { evClose?.delete(cb) }
        },
        /**
         * @deprecated Скоро будет убран. Снимайте close-обработчик через `off()`,
         * который возвращает `eventClose(cb)`. Сохранено для обратной совместимости.
         */
        removeEventClose: (cb: (()=>void)) => {
            const e=sinh?.get(cb)
            if (e) evClose?.delete(e)
            sinh?.delete(cb)
            evClose?.delete(cb)
        },
        addListen: (cb: Listener<Z>, {cbClose, key}: {cbClose?: () => void, key?: key } = {}) => {
            const k = key ?? cb
            obj.set(k, cb)
            if (cbClose) {
                if (evClose && evClose.has(k)) {
                    const r=evClose.get(k)!
                    if (r!==cbClose) {
                        evClose.delete(r)
                        evClose.delete(k)
                        sinh?.delete(r)
                    }
                }
                evClose = evClose ?? new Map()
                evClose.set(k, cbClose)
                sinh = sinh ?? new Map()
                sinh.set(cbClose, cb)
            }
            if (fast) rebuild()
            event?.("add", obj.size, api)
            return () => removeKey(k)
        },
        /**
         * @deprecated Скоро будет убран. Снимайте подписку через `off()`, который
         * возвращает `addListen()` (идиома `const off = listen.addListen(cb); off()`),
         * либо через slim-`Listen2`/`UseListen2`. Метод сохранён только для обратной
         * совместимости и делегирует в ту же внутреннюю логику, что и `off()`.
         */
        removeListen: (k: Listener<Z> | null| key) => removeKey(k),
        count: () => obj.size,
        /**
         * @deprecated Скоро будет убран. Интроспекция ключей — не часть slim-API;
         * сохранено для обратной совместимости.
         */
        get getAllKeys(): (Listener<NormalizeTuple<T>>|key)[] { return [...obj.keys()] }
    }
    return api
}
export function funcListenCallbackFast<T>(a: (e: (Listener<NormalizeTuple<T>>|null))=>(void | (()=>void))) {
    return funcListenCallbackBase<T>(a, {fast: true})
}
export const funcListenCallback= funcListenCallbackBase

export function UseListen<T>(data: Parameters<typeof funcListenCallbackBase<T>>[1] = {fast : true}) {
    let t: ((...a: NormalizeTuple<T>) => void)
    const a = funcListenCallbackBase<T>((e)=>{t = e}, {fast: true, ...data})
    a.run()
    t = a.func
    return [t, a] as const
}

// =====================================================================
// SLIM API v2 — минимальная поверхность подписчика (off()-only)
// =====================================================================
// Полный api (funcListenCallbackBase) исторически оброс методами, из которых
// на практике используется горстка, а половина дублирует друг друга
// (removeListen ≈ off(), removeEventClose ≈ off() от eventClose, getAllKeys).
// Listen2 — это outward-фасад (audience-split по CLAUDE.md: control = emit,
// api = подписка), который оставляет только нужное:
//   • on(cb) -> off()  — единственный способ отписки (идиома off);
//   • close()          — снести весь Listen (clean);
//   • count()          — нагруженная семантика cold/hot (0↔1).
// Это СТРОГО подмножество старого api поверх той же реализации — никакой новой
// логики, полная совместимость поведения. Старые методы остаются и помечены
// @deprecated (см. выше).

export type Listen2<T> = {
    /** Подписаться. Возвращает `off()` — ЕДИНСТВЕННЫЙ способ отписки в v2. */
    on: (cb: Listener<NormalizeTuple<T>>, opts?: {key?: string}) => (() => void)
    /** Снести весь Listen: close-обработчики + сброс всех подписчиков. */
    close: () => void
    /** Текущее число подписчиков (для cold/hot-переходов). */
    count: () => number
}

/** Slim-вид поверх полного api funcListenCallbackBase. Без новой логики. */
export function toListen2<T>(full: ReturnType<typeof funcListenCallbackBase<T>>): Listen2<T> {
    return {
        on: (cb, opts) => full.addListen(cb, opts),
        close: () => full.close(),
        count: () => full.count(),
    }
}

/**
 * Slim-аналог UseListen: возвращает `[emit, listen]`, где listen — это Listen2
 * (только on/close/count). Для нового кода предпочтительнее полного UseListen.
 */
export function UseListen2<T>(data: Parameters<typeof funcListenCallbackBase<T>>[1] = {fast: true}) {
    const [emit, full] = UseListen<T>(data)
    return [emit, toListen2<T>(full)] as const
}

/** Проверяет, является ли объект результатом funcListenCallbackBase */
let referenceKeys: string[] | null = null
let referenceTypes: Map<string, string> | null = null

function getReferenceData(): { keys: string[], types: Map<string, string> } {
    if (!referenceKeys || !referenceTypes) {
        const demo = funcListenCallbackBase(() => {})
        referenceKeys = Object.keys(demo).sort()
        referenceTypes = new Map()

        // Сохраняем типы всех свойств
        for (const key of referenceKeys) {
            referenceTypes.set(key, typeof (demo as any)[key])
        }
    }
    return { keys: referenceKeys, types: referenceTypes }
}
// 2. Безопасная проверка
export function isListenCallback(obj: any): obj is ReturnType<typeof funcListenCallbackBase> {
    if (obj == null || typeof obj !== "object") return false

    // Получаем ключи БЕЗ обращения к свойствам (безопасно от геттеров/Proxy)
    const objKeys = Object.keys(obj).sort()
    const { keys: refKeys, types: refTypes } = getReferenceData()

    // Сравниваем количество ключей
    if (objKeys.length !== refKeys.length) return false

    // Сравниваем названия ключей
    for (let i = 0; i < refKeys.length; i++) {
        if (objKeys[i] !== refKeys[i]) return false
    }

    // Проверяем типы всех свойств
    for (const key of refKeys) {
        const expectedType = refTypes.get(key)
        const actualType = typeof obj[key]

        if (actualType !== expectedType) return false
    }

    return true
}