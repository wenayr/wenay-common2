// =====================================================================
// Listen3 — слоистая переработка Listen (кандидат на замену Listen.ts / Listen2.ts)
// =====================================================================
// Три слоя, каждый владеет ТОЛЬКО своим состоянием (в отличие от Listen2.ts,
// где обёртка дублировала бухгалтерию ядра — keyCb/cbKeys велись дважды):
//
//   1. funcListenCore         — utility: чистый реестр подписчиков (key→cb) с
//                               fast-диспетчером. Никакого жизненного цикла.
//   2. funcListenCallbackBase — resource: run/close-жизненный цикл + cbClose-хуки.
//                               Бухгалтерию подписок НЕ ведёт — делегирует ядру и
//                               узнаёт о выбытии ключей через хук onRemove.
//   3. withStoreListen        — декоратор `current`: replay последнего значения
//                               новым подписчикам (семантика BehaviorSubject).
//
// Публичная поверхность повторяет Listen.ts/Listen2.ts (drop-in): func, addListen,
// removeListen, on, once, eventClose/onClose/removeEventClose, close, count,
// getAllKeys, isRun, run + slim-фасад Listen2 и реестр идентичности по `on`.

export type Listener<T extends any[]> = (...r: T) => void

/** Нормализация: если T уже кортеж — оставляем, иначе оборачиваем в [T] */
export type NormalizeTuple<T> = T extends any[] ? T : [T]

type key = string | symbol
type cbClose = () => void

// Фантомный бренд (ТОЛЬКО на уровне типов) функции on: несёт типы аргументов Z, чтобы
// wire-проекция (DeepSocketListen) узнала «голый on» среди обычных функций и развернула
// подписочную поверхность {on, once, close, ...}. Бренд ОБЯЗАТЕЛЕН → обычная функция его
// не имеет, поэтому под ветку ListenOn она не попадает (дискриминация). Рантайма у бренда нет.
declare const LISTEN_ON_BRAND: unique symbol
export type ListenOn<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: { cbClose?: cbClose; key?: key }) => (() => void))
    & { readonly [LISTEN_ON_BRAND]: Z }

export type ListenOnCurrent<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: { cbClose?: cbClose; key?: key; current?: ListenCurrent<Z> }) => (() => void))
    & { readonly [LISTEN_ON_BRAND]: Z }

/** Поставщик «текущего значения» для replay-подписки (store-слой). */
export type ListenCurrentProvider<Z extends any[]> = () => Z | undefined
/** true → взять значение у провайдера store; функция → взять у неё (переопределение per-sub). */
export type ListenCurrent<Z extends any[]> = boolean | ListenCurrentProvider<Z>

export type ListenCoreOptions<T = any> = {
    fast?: boolean
    /**
     * Хук выбытия ключа из реестра: off()/removeListen/перезапись по key.
     * НЕ вызывается на close() — владелец сносит своё сопутствующее состояние оптом.
     * Именно через него слой жизненного цикла чистит cbClose-привязки, не ведя
     * собственной копии реестра.
     */
    onRemove?: (k: key) => void
    // Listen2-compatible event hook. Core itself stays independent; api is passed
    // only for callers that historically observed it from funcListenCore().
    event?: (type: 'add' | 'remove', count: number, api: ListenCoreApi<T>) => void
}

export type ListenOptions<T> = {
    event?: (type: 'add' | 'remove', count: number, api: ListenApi<T>) => void
    fast?: boolean
    /** Close-signal Listen: его событие закрывает этот Listen; parent.close() сам по себе не эмитит. */
    addListenClose?: ListenApi<any>
}

export type ListenStoreOptions<T> = ListenOptions<T> & {
    current: ListenCurrentProvider<NormalizeTuple<T>>
}

// ============================================================
// Реестр идентичности: api.on → весь api (по ССЫЛКЕ, не по форме).
// ============================================================
// У каждого Listen УНИКАЛЬНАЯ функция on. Регистрируем её при создании → Listen можно
// надёжно узнать по identity (а не хрупким duck-type) и достать его api. Назначение:
// прокинуть через веб ТОЛЬКО ссылку `on`, а wire-слой по реестру восстановит slim {on, once, close}.
const listenByOn = new WeakMap<Function, any>()
/** api Listen по его функции `on` (или undefined, если fn — не зарегистрированный on). */
export function getListenByOn(fn: any) { return typeof fn == 'function' ? listenByOn.get(fn) : undefined }
/** Является ли fn функцией `on` какого-то Listen (проверка по ссылке в реестре). */
export function isListenOn(fn: any): boolean { return typeof fn == 'function' && listenByOn.has(fn) }

// =====================================================================
// СЛОЙ 1: ядро — реестр подписчиков (utility, без жизненного цикла)
// =====================================================================
// Единственный владелец карты key→cb. Горячие операции on/off по ключу — O(1).
// fast-диспетчер: под размер 0/1/2/N собирается специализированная функция `a`,
// чтобы горячий путь emit не платил за общий цикл.
export function funcListenCore<T>(options: ListenCoreOptions<T> = {}) {
    const {fast = true, onRemove, event} = options
    type Z = NormalizeTuple<T>
    const subs = new Map<key, Listener<Z>>()
    let a: Listener<Z> | null = (...e) => { subs.forEach(z => z(...e)) }
    let cached: Listener<Z>[] | null = null

    const getArr = () => cached ?? (cached = Array.from(subs.values()))

    function rebuild() {
        cached = null
        const size = subs.size
        if (size == 0) { a = null; return }
        if (size == 1) { a = subs.values().next().value!; return }
        if (size == 2) {
            const [a0, a1] = getArr()
            a = ((...e) => { a0(...e); a1(...e) }) as Listener<Z>
            return
        }
        a = ((...e) => {
            const ar = getArr()
            for (let i = 0, len = ar.length; i < len; i++) ar[i](...e)
        }) as Listener<Z>
    }

    function removeOne(k: key) {
        if (!subs.has(k)) return
        subs.delete(k)
        onRemove?.(k)
        if (fast) rebuild()
        event?.('remove', subs.size, api)
    }

    const api = {
        func: ((...e: Z) => { a?.(...e) }) as Listener<Z>,
        has: (k: key) => subs.has(k),
        on: ((cb: Listener<Z>, {key}: {key?: key} = {}) => {
            const k = key ?? Symbol()
            // Перезапись по ключу: снимаем старые owner-привязки, но не шлём отдельный
            // remove-event — снаружи это одна операция замены подписчика.
            if (subs.has(k)) { subs.delete(k); onRemove?.(k) }
            subs.set(k, cb)
            if (fast) rebuild()
            event?.('add', subs.size, api)
            return function off() { removeOne(k) }
        }) as ListenOn<Z>,
        /** @deprecated Используйте on(cb, opts) и сохранённый off(). */
        addListen: (cb: Listener<Z>, opts: {key?: key} = {}) => api.on(cb, opts),
        /** @deprecated Используйте off(), который вернул on()/addListen(). */
        removeListen: (k: Listener<Z> | null | key) => {
            if (typeof k == 'function') {
                for (const [kk, cb] of [...subs]) if (cb === k) removeOne(kk)
                return
            }
            if (k != null) removeOne(k)
        },
        once: (cb: Listener<Z>, opts: {key?: key} = {}) => {
            let off: () => void = () => {}
            off = api.on(((...e: Z) => { off(); cb(...e) }), opts)
            return off
        },
        // Оптовый снос: onRemove per-key НЕ дёргается и 'remove' не шлётся —
        // владелец, вызвавший close, чистит своё состояние сам (см. слой 2).
        close: () => {
            subs.clear()
            if (fast) rebuild()
        },
        count: () => subs.size,
        get getAllKeys(): key[] { return [...subs.keys()] },
    }
    // Listen2 compatibility: core historically exposed a branded on() and was discoverable
    // by the identity registry. Keep that so the ./listen2 surface can be repointed safely.
    listenByOn.set(api.on, api)
    return api
}
export type ListenCoreApi<T = any> = ReturnType<typeof funcListenCore<T>>

// =====================================================================
// СЛОЙ 2: жизненный цикл — run/close + cbClose-хуки (resource)
// =====================================================================
// Владеет ТОЛЬКО своим: teardown из run(), каскад addListenClose и две ленивые
// структуры close-хуков. Реестр подписок целиком в ядре; о выбытии ключа слой
// узнаёт через onRemove и снимает соответствующую cbClose-привязку.
export function funcListenCallbackBase<T>(
    b: (e: Listener<NormalizeTuple<T>>) => (void | (() => void)),
    options: ListenOptions<T> = {},
) {
    const {fast = true, event, addListenClose} = options
    type Z = NormalizeTuple<T>
    // Ленивая ordered-map close-хуков: standalone eventClose(cb) и per-sub cbClose
    // живут в одном порядке вставки, как в Listen.ts. При обычном off() per-sub hook
    // молча снимается через onRemove; стреляет только close() всего Listen.
    let closeHooks: Map<key | cbClose, cbClose> | null = null
    let close: (() => void) | null = null
    let closeUnsubscribe: (() => void) | null = null

    // Выбытие ключа из ядра (off/removeListen/перезапись) → снять cbClose-привязку.
    function forgetKey(k: key) {
        closeHooks?.delete(k)
    }

    const core = funcListenCore<T>({
        fast,
        onRemove: forgetKey,
        // 'remove' пробрасываем из ядра как есть; 'add' фильтруем и шлём сами из
        // addListen ПОСЛЕ регистрации cbClose — чтобы обработчик события видел
        // подписку полностью оформленной (порядок как в Listen.ts).
        event: event && function forwardRemove(type, count) {
            if (type == 'remove') event(type, count, api)
        },
    })

    const api = {
        func: core.func,
        isRun: () => close !== null,
        run: () => {
            close = (b(core.func) ?? (() => {})) as (() => void)
            if (addListenClose && !closeUnsubscribe) {
                closeUnsubscribe = addListenClose.on(function onOwnerClose() { api.close() })
            }
        },
        close: () => {
            close?.()
            close = null
            core.close()
            if (closeHooks) { const hooks = closeHooks; closeHooks = null; hooks.forEach(function fireClose(cb) { cb() }) }
            if (closeUnsubscribe) {
                closeUnsubscribe()
                closeUnsubscribe = null
            }
        },
        /**
         * @deprecated Используйте `onClose(cb)` — та же семантика и тот же `off()`.
         */
        eventClose: (cb: cbClose) => {
            closeHooks = closeHooks ?? new Map()
            closeHooks.set(cb, cb)
            return function offClose() { closeHooks?.delete(cb) }
        },
        /** Подписка на закрытие потока (идиома `on('close')`). Возвращает `off()`. */
        onClose: (cb: cbClose) => api.eventClose(cb),
        /**
         * @deprecated Снимайте close-обработчик через `off()`, который возвращает
         * `eventClose(cb)`. Сохранено для обратной совместимости.
         */
        removeEventClose: (cb: cbClose) => { closeHooks?.delete(cb) },
        /**
         * Подписаться. Возвращает `off()` — единственный способ отписки (идиома
         * `const off = listen.on(cb); off()`). `opts.key` — перезапись по ключу,
         * `opts.cbClose` — per-sub close-хук.
         */
        on: ((cb: Listener<Z>, {cbClose, key}: {cbClose?: cbClose, key?: key} = {}) => {
            const k = key ?? Symbol()
            const off = core.on(cb, {key: k})
            if (cbClose) {
                closeHooks = closeHooks ?? new Map()
                closeHooks.set(k, cbClose)
            }
            event?.('add', core.count(), api)
            return off
        }) as ListenOn<Z>,
        /** @deprecated Используйте on(cb, opts) и сохранённый off(). */
        addListen: (cb: Listener<Z>, opts: {cbClose?: cbClose, key?: key} = {}) => api.on(cb, opts),
        /** @deprecated Снимайте подписку через off(), который вернул on()/addListen(). */
        removeListen: core.removeListen,
        /**
         * Подписаться ОДНОКРАТНО: после первого события автоматически отписывается.
         * Возвращает `off()` (досрочная отписка). Идиома EventEmitter.once.
         */
        once: (cb: Listener<Z>, opts: {key?: key} = {}) => {
            let off: () => void = () => {}
            off = api.on(((...e: Z) => { off(); cb(...e) }), opts)
            return off
        },
        count: () => core.count(),
        /** @deprecated Интроспекция ключей — не часть slim-API; для обратной совместимости. */
        get getAllKeys(): key[] { return core.getAllKeys },
    }
    // Идентичность: по api.on находим весь api (для slim-проксирования {on, once, close} через веб).
    listenByOn.set(api.on, api)
    return api
}
export type ListenApi<T = any> = ReturnType<typeof funcListenCallbackBase<T>>

export function funcListenCallbackFast<T>(a: (e: (Listener<NormalizeTuple<T>> | null)) => (void | (() => void))) {
    return funcListenCallbackBase<T>(a, {fast: true})
}
export const funcListenCallback = funcListenCallbackBase

export function UseListen<T>(data: ListenOptions<T> = {fast: true}) {
    let t: ((...a: NormalizeTuple<T>) => void)
    const a = funcListenCallbackBase<T>((e) => { t = e }, {fast: true, ...data})
    a.run()
    t = a.func
    return [t, a] as const
}

// =====================================================================
// СЛОЙ 3: store-декоратор — replay «текущего значения» (current)
// =====================================================================
// Оборачивает готовый ListenApi, добавляя opts.current к on/once/addListen:
// новый подписчик сразу получает текущее значение (семантика BehaviorSubject).
// Никакого своего состояния — только провайдер значения.
export function withStoreListen<T>(base: ListenApi<T>, currentProvider: ListenCurrentProvider<NormalizeTuple<T>>) {
    type Z = NormalizeTuple<T>
    function currentValue(current?: ListenCurrent<Z>) {
        if (typeof current == 'function') return current()
        return current ? currentProvider() : undefined
    }
    const api = {
        ...base,
        on: ((cb: Listener<Z>, {cbClose, key, current}: {cbClose?: cbClose, key?: key, current?: ListenCurrent<Z>} = {}) => {
            const off = base.on(cb, {cbClose, key})
            if (current) {
                const m = currentValue(current)
                if (m) cb(...m)
            }
            return off
        }) as ListenOnCurrent<Z>,
        /** @deprecated Используйте on(cb, opts) и сохранённый off(). */
        addListen: (cb: Listener<Z>, opts: {cbClose?: cbClose, key?: key, current?: ListenCurrent<Z>} = {}) => api.on(cb, opts),
        once: (cb: Listener<Z>, opts: {key?: key, current?: ListenCurrent<Z>} = {}) => {
            // current при once: replay текущего значения И ЕСТЬ то самое одно событие —
            // подписка не создаётся вовсе.
            if (opts.current) {
                const m = currentValue(opts.current)
                if (m) { cb(...m); return () => {} }
            }
            let off: () => void = () => {}
            off = base.on(((...e: Z) => { off(); cb(...e) }), {key: opts.key})
            return off
        },
        // Спред выше «сфотографировал» бы геттер base.getAllKeys в мёртвый массив —
        // восстанавливаем живой геттер поверх копии.
        get getAllKeys(): key[] { return base.getAllKeys },
    }
    listenByOn.set(api.on, api)
    return api
}
export type ListenStoreApi<T> = ReturnType<typeof withStoreListen<T>>

export function funcListenCallbackStore<T>(
    b: (e: Listener<NormalizeTuple<T>>) => (void | (() => void)),
    options: ListenStoreOptions<T>,
) {
    const {current, ...listenOptions} = options
    return withStoreListen(funcListenCallbackBase<T>(b, listenOptions), current)
}

export function UseListenStore<T>(data: ListenStoreOptions<T>) {
    const {current, ...listenOptions} = data
    let t: ((...a: NormalizeTuple<T>) => void)
    const base = funcListenCallbackBase<T>((e) => { t = e }, {fast: true, ...listenOptions})
    const listen = withStoreListen<T>(base, current)
    base.run()
    t = base.func
    return [t, listen] as const
}

// =====================================================================
// SLIM API v2 — минимальная поверхность подписчика (off()-only)
// =====================================================================
// Outward-фасад (audience-split: control = emit, api = подписка): только
// on(cb)→off(), close() и count(). Строго подмножество полного api.
export function toListen2<T>(full: ListenApi<T>) {
    return {
        /** Подписаться. Возвращает `off()` — ЕДИНСТВЕННЫЙ способ отписки в v2. */
        on: (cb: Listener<NormalizeTuple<T>>, opts?: {key?: key}) => full.on(cb, opts),
        /** Снести весь Listen: close-обработчики + сброс всех подписчиков. */
        close: () => full.close(),
        /** Текущее число подписчиков (для cold/hot-переходов). */
        count: () => full.count(),
    }
}
export type Listen2<T> = ReturnType<typeof toListen2<T>>

/** Slim-аналог UseListen: `[emit, listen]`, где listen — только on/close/count. */
export function UseListen2<T>(data: ListenOptions<T> = {fast: true}) {
    const [emit, full] = UseListen<T>(data)
    return [emit, toListen2<T>(full)] as const
}

// ===================================================================
// isListenCallback — устойчив к АДДИТИВНОМУ росту full-api.
// ===================================================================
// Проверяем СТАБИЛЬНОЕ ЯДРО — ровно ту подписочную поверхность, которую реально
// потребляет listenSocket. Подмножество-контракт: лишние члены игнорируются;
// slim-Listen2 (on/close/count — без addListen/func) корректно НЕ проходит;
// добавление новых членов детекцию не ломает.
const LISTEN_CORE = ['func', 'addListen', 'removeListen', 'eventClose', 'removeEventClose'] as const

export function isListenCallback(obj: any): obj is ListenApi {
    if (obj == null || typeof obj != 'object') return false
    // Сначала НАЛИЧИЕ core-ключей как собственных перечислимых (Object.keys не дёргает
    // get-трапы по значениям) — чужой объект/Proxy без них отсекается, свойства не трогаем.
    const ks = new Set(Object.keys(obj))
    for (const k of LISTEN_CORE) if (!ks.has(k)) return false
    for (const k of LISTEN_CORE) if (typeof (obj as any)[k] != 'function') return false
    return true
}
