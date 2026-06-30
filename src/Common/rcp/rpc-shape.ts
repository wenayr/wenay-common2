// rpc-shape.ts
//
// ============================================================
// Адаптивное уплотнение ТИКОВ ПОДПИСКИ (динамическое, не статичное)
// ============================================================
// Подписка отдаёт объекты ДИНАМИЧЕСКОЙ формы. Сервер считает частоту форм per-cbId;
// форма, повторившаяся THRESHOLD раз, получает shapeId — дальше тик шлётся компактно
// (только значения, ключи — один раз в Pkt.SHAPE). Держим до MAX_SHAPES форм одновременно
// (может быть 2-3 «стандарта»); счётчики НЕ обнуляются. Жмём ТОЛЬКО объекты и ТОЛЬКО частые —
// редкие/полиморфные/не-объекты идут полным Pkt.CB. Сравнения форм попарно нет: сигнатура
// строится из ключей, дальше поиск по ней (дёшево относительно самой сериализации).

const THRESHOLD = 5  // сколько раз форма должна встретиться, прежде чем её стандартизируем
const MAX_SHAPES = 5 // максимум одновременно отслеживаемых форм на один cbId

// только «голый» объект-запись: массив/Date/Map/Set/RegExp/класс — не уплотняем
export function isPlainObject(v: any) {
    if (v == null || typeof v != "object") return false
    if (Array.isArray(v) || v instanceof Date || v instanceof Map || v instanceof Set || v instanceof RegExp) return false
    const p = Object.getPrototypeOf(v)
    return p == null || p == Object.prototype
}

type tShape = { sig: string; keys: string[]; count: number; shapeId: number }

export function createCbShapeServer(threshold = THRESHOLD, maxShapes = MAX_SHAPES) {
    const byCb = new Map<number, { shapes: tShape[]; nextId: number }>()

    // offer возвращает РЕШЕНИЕ (ключи отдаём наружу, значения пакует вызывающий):
    //   full     — слать обычным Pkt.CB
    //   register — впервые стандартизируем: сначала Pkt.SHAPE(keys), затем Pkt.CBV(values)
    //   compact  — уже стандартизирована: только Pkt.CBV(values)
    function offer(cbId: number, obj: any) {
        const keys = Object.keys(obj)
        const sig = keys.slice().sort().join("\x00") // порядок-независимая сигнатура формы
        let st = byCb.get(cbId)
        if (!st) { st = { shapes: [], nextId: 0 }; byCb.set(cbId, st) }
        const sh = st.shapes.find(s => s.sig == sig)
        if (sh) {
            sh.count++
            if (sh.shapeId >= 0) return { mode: "compact" as const, shapeId: sh.shapeId, keys: sh.keys }
            if (sh.count >= threshold) { sh.shapeId = st.nextId++; return { mode: "register" as const, shapeId: sh.shapeId, keys: sh.keys } }
            return { mode: "full" as const }
        }
        // новую форму берём кандидатом, пока есть слоты; сверх MAX_SHAPES — просто полный объект
        if (st.shapes.length < maxShapes) st.shapes.push({ sig, keys, count: 1, shapeId: -1 })
        return { mode: "full" as const }
    }

    function drop(cbId: number) { byCb.delete(cbId) }
    return { offer, drop }
}
