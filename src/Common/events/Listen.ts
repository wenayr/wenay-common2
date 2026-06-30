export type Listener<T extends any[]> = (...r: T) => void

/** Нормализация: если T уже кортеж — оставляем, иначе оборачиваем в [T] */
export type NormalizeTuple<T> = T extends any[] ? T : [T]

type key = string | symbol

// Фантомный бренд (ТОЛЬКО на уровне типов) функции on Listen: несёт типы аргументов Z, чтобы
// wire-проекция (DeepSocketListen) узнала «голый on» среди обычных функций и развернула
// подписочную поверхность {on, once, close, ...}. Бренд ОБЯЗАТЕЛЕН → обычная функция его не имеет,
// поэтому под ветку ListenOn она не попадает (дискриминация). Рантайма у бренда нет.
declare const LISTEN_ON_BRAND: unique symbol
export type ListenOn<Z extends any[] = any[]> =
    ((cb: Listener<Z>, opts?: { cbClose?: () => void; key?: string }) => (() => void))
    & { readonly [LISTEN_ON_BRAND]: Z }

// ============================================================
// Реестр идентичности Listen: api.on → весь api (по ССЫЛКЕ, не по форме).
// ============================================================
// У каждого Listen УНИКАЛЬНАЯ функция on. Регистрируем её при создании → Listen можно
// надёжно узнать по identity (а не хрупким duck-type) и достать его api. Назначение:
// прокинуть через веб ТОЛЬКО ссылку `on`, а wire-слой по реестру восстановит slim {on, once, close}.
const listenByOn = new WeakMap<Function, any>()
/** api Listen по его функции `on` (или undefined, если fn — не зарегистрированный on). */
export function getListenByOn(fn: any) { return typeof fn == "function" ? listenByOn.get(fn) : undefined }
/** Является ли fn функцией `on` какого-то Listen (проверка по ссылке в реестре). */
export function isListenOn(fn: any): boolean { return typeof fn == "function" && listenByOn.has(fn) }

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
    const cbKeys = new Map<Listener<Z>, Array<Listener<Z>|key>>()
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
    function forgetKey(k: Listener<Z> | key) {
        const removed = obj.get(k)
        if (typeof removed == "function") {
            const keys = cbKeys.get(removed)
            if (keys) {
                const i = keys.indexOf(k)
                if (i >= 0) keys.splice(i, 1)
                if (keys.length == 0) cbKeys.delete(removed)
            }
        }
        const e = evClose?.get(k)
        evClose?.delete(k)
        if (e) {
            evClose?.delete(e)
            sinh?.delete(e)
        }
    }

    function removeKey(k: Listener<Z> | null | key) {
        if (!obj.has(k!)) return
        obj.delete(k!)
        forgetKey(k!)
        if (fast) rebuild()
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
            cbKeys.clear()
            if (fast) rebuild()
            sinh = null
            if (evClose) { evClose.forEach(cb => cb()); evClose = null }
            
            // Отписываемся от события закрытия
            if (closeUnsubscribe) {
                closeUnsubscribe()
                closeUnsubscribe = null
            }
        },
        /**
         * @deprecated Используйте `onClose(cb)` — та же семантика и тот же `off()`.
         * Сохранено для обратной совместимости.
         */
        eventClose: (cb: ()=>void) => {
            evClose = evClose ?? new Map()
            evClose.set(cb, cb)
            return () => { evClose?.delete(cb) }
        },
        /**
         * Подписка на закрытие потока (идиома `on('close')`). Возвращает `off()`.
         * Делегирует в ту же логику, что и `eventClose`.
         */
        onClose: (cb: ()=>void) => api.eventClose(cb),
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
        /**
         * @deprecated Используйте `on(cb, opts)` — та же подписка и тот же `off()`
         * (идиома `const off = listen.on(cb); off()`). Сохранено для обратной
         * совместимости и делегирует в ту же реализацию, что и `on`.
         */
        addListen: (cb: Listener<Z>, {cbClose, key}: {cbClose?: () => void, key?: key } = {}) => {
            const k = key ?? Symbol()
            if (obj.has(k)) forgetKey(k)
            obj.set(k, cb)
            let keys = cbKeys.get(cb)
            if (!keys) cbKeys.set(cb, keys = [])
            keys.push(k)
            if (cbClose) {
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
        removeListen: (k: Listener<Z> | null| key) => {
            if (typeof k == "function" && !obj.has(k)) for (const kk of [...(cbKeys.get(k) ?? [])]) removeKey(kk)
            else removeKey(k)
        },
        /**
         * Подписаться. Возвращает `off()` — единственный способ отписки (идиома
         * `const off = listen.on(cb); off()`). `opts.key` — перезапись по ключу,
         * `opts.cbClose` — per-sub close-хук. Делегирует в ту же реализацию, что
         * и `addListen`.
         */
        on: ((cb: Listener<Z>, opts: {cbClose?: () => void, key?: key } = {}) => api.addListen(cb, opts)) as ListenOn<Z>,
        /**
         * Подписаться ОДНОКРАТНО: после первого события автоматически отписывается.
         * Возвращает `off()` (досрочная отписка). Идиома EventEmitter.once.
         */
        once: (cb: Listener<Z>, opts: {key?: key } = {}) => {
            let off: () => void = () => {}
            off = api.addListen(((...e: Z) => { off(); cb(...e) }), opts)
            return off
        },
        count: () => obj.size,
        /**
         * @deprecated Скоро будет убран. Интроспекция ключей — не часть slim-API;
         * сохранено для обратной совместимости.
         */
        get getAllKeys(): (Listener<NormalizeTuple<T>>|key)[] { return [...obj.keys()] }
    }
    // Идентичность: по api.on находим весь api (для slim-проксирования {on, once, close} через веб).
    listenByOn.set(api.on, api)
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

// ===================================================================
// isListenCallback — ДОЛЖЕН быть устойчив к АДДИТИВНОМУ росту full-api.
// ===================================================================
// Раньше сверяли ТОЧНЫЙ набор ключей с эталоном funcListenCallbackBase(). Это хрупко:
// любой новый член (on/onClose/…) менял эталон и ломал детекцию у ВСЕХ конформеров,
// которые руками воспроизводят форму (observable-узлы reactive.ts, wire-реконструкция
// transit.ts) и про новый член не знают. Теперь проверяем СТАБИЛЬНОЕ ЯДРО — ровно ту
// подписочную поверхность, которую реально потребляет listenSocket (listen-socket.ts:76).
// Подмножество-контракт: лишние члены игнорируются; slim-Listen2 (on/close/count — без
// addListen/func) корректно НЕ проходит; добавление новых членов детекцию больше не ломает.
const LISTEN_CORE = ["func", "addListen", "removeListen", "eventClose", "removeEventClose"] as const

export function isListenCallback(obj: any): obj is ReturnType<typeof funcListenCallbackBase> {
    if (obj == null || typeof obj !== "object") return false
    // Сначала НАЛИЧИЕ core-ключей как собственных перечислимых (Object.keys не дёргает
    // get-трапы по значениям) — чужой объект/Proxy без них отсекается, свойства не трогаем.
    const ks = new Set(Object.keys(obj))
    for (const k of LISTEN_CORE) if (!ks.has(k)) return false
    // Затем убеждаемся, что core-члены — функции.
    for (const k of LISTEN_CORE) if (typeof (obj as any)[k] !== "function") return false
    return true
}
