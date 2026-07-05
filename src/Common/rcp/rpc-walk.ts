import { idPool } from "../id-pool";
import { isSafeKey, PayloadLimitError, type RpcLimits } from "./rpc-limits";
import { RPC_STOP } from "./rpc-protocol";

const FN_MARKER     = "$_f";
const DATE_MARKER   = "$_d";
const MAP_MARKER    = "$_m";
const SET_MARKER    = "$_s";
const REGEXP_MARKER = "$_r";
const BIGINT_MARKER = "$_b";

const ALL_MARKERS = new Set([FN_MARKER, DATE_MARKER, MAP_MARKER, SET_MARKER, REGEXP_MARKER, BIGINT_MARKER]);

// Вложенные значения внутри Map/Set тоже проходят (де)сериализацию рекурсивно —
// иначе Date/Map внутри Map уходят сырыми и гибнут на JSON-транспорте.
const deepSerialize = (v: any): any => walk(v, serializeLeaf);
const deepDeserialize = (v: any, lim?: Required<RpcLimits>): any =>
    walk(v, l => deserializeLeaf(l, undefined, lim), lim);

// Маппинг маркер → десериализатор
const DESERIALIZERS: Record<string, (v: any, lim?: Required<RpcLimits>) => any> = {
    [DATE_MARKER]:   (v) => new Date(v),
    [MAP_MARKER]:    (v, lim) => new Map(v.map(([k, val]: [any, any]) => [deepDeserialize(k, lim), deepDeserialize(val, lim)])),
    [SET_MARKER]:    (v, lim) => new Set(v.map((x: any) => deepDeserialize(x, lim))),
    [REGEXP_MARKER]: (v) => new RegExp(v.source, v.flags),
    [BIGINT_MARKER]: (v) => BigInt(v),
};

// Маппинг тип → сериализатор (пары [маркер, значение])
type Serializer = (v: any) => [string, any] | null;

const SERIALIZERS: Serializer[] = [
    (v) => v instanceof Date    ? [DATE_MARKER,   v.valueOf()]                          : null,
    (v) => v instanceof Map     ? [MAP_MARKER,    Array.from(v.entries(), ([k, val]: [any, any]) => [deepSerialize(k), deepSerialize(val)])] : null,
    (v) => v instanceof Set     ? [SET_MARKER,    Array.from(v.values(), (x: any) => deepSerialize(x))] : null,
    (v) => v instanceof RegExp  ? [REGEXP_MARKER, { source: v.source, flags: v.flags }] : null,
    (v) => typeof v === "bigint" ? [BIGINT_MARKER, v.toString()]                        : null,
];

// Бинарный лист: TypedArray/DataView/Buffer (isView) и голый ArrayBuffer.
// null = не бинарь; число = byteLength (для лимита).
function binaryByteLength(v: any): number | null {
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (v instanceof ArrayBuffer) return v.byteLength;
    return null;
}

export function walk(
    val: any,
    onLeaf: (v: any) => any,
    lim?: Required<RpcLimits>,
    depth = 0,
): any {
    if (lim) {
        if (depth > lim.maxDepth) throw new PayloadLimitError("max depth exceeded");
        if (typeof val == "string" && val.length > lim.maxStringLen) throw new PayloadLimitError("string too long");
    }
    if (val == null || typeof val !== "object") return onLeaf(val);
    // Бинарь — passthrough МИМО onLeaf и ДО Object.keys: socket.io возит его нативно,
    // ни один (де)сериализатор бинарь не метит (identity by design), а Object.keys
    // у большого буфера — это массив из миллионов строк-ключей ({0:…,1:…}-раздувание,
    // которое здесь и лечим). Проверка байтового потолка — единственное, что нужно.
    const bin = binaryByteLength(val);
    if (bin != null) {
        if (lim && bin > lim.maxBinaryLen) throw new PayloadLimitError("binary too long");
        return val;
    }
    // Если объект уже упакован маркером — передаём как есть в onLeaf
    if (val instanceof Date || val instanceof Map || val instanceof Set || val instanceof RegExp) return onLeaf(val);

    // Упакованный лист — это ВСЕГДА объект из одного ключа-маркера ({ $_d: ... }).
    // Раньше проверяли только первый ключ → обычный объект, чей первый ключ случайно
    // совпал с маркером ({ $_d: 5, name: "x" }), ошибочно считался листом и терял остальные
    // ключи. Требуем ровно один ключ — многоключевые объекты идут в обычную рекурсию.
    const ks0 = Object.keys(val);
    if (ks0.length === 1 && ALL_MARKERS.has(ks0[0])) return onLeaf(val);
    if (Array.isArray(val)) {
        if (lim && val.length > lim.maxArrayLen) throw new PayloadLimitError("array too long");
        return val.map(v => walk(v, onLeaf, lim, depth + 1));
    }
    const keys = Object.keys(val);
    if (lim && keys.length > lim.maxKeys) throw new PayloadLimitError("too many keys in object");
    const o: any = {};
    for (const k of keys) if (isSafeKey(k)) o[k] = walk(val[k], onLeaf, lim, depth + 1);
    return o;
}

// Общая функция десериализации листа (используется в unpack и unpackResult)
function deserializeLeaf(leaf: any, onCallback?: (id: number) => any, lim?: Required<RpcLimits>): any {
    if (leaf == null || typeof leaf !== "object") return leaf;
    const key = Object.keys(leaf)[0];
    if (!key) return leaf;

    if (key === FN_MARKER) {
        return onCallback?.(leaf[FN_MARKER]) ?? leaf;
    }

    const deserialize = DESERIALIZERS[key];
    return deserialize ? deserialize(leaf[key], lim) : leaf;
}

// Общая функция сериализации листа (используется в pack и packResult)
function serializeLeaf(leaf: any): any {
    for (const serializer of SERIALIZERS) {
        const result = serializer(leaf);
        if (result) return { [result[0]]: result[1] };
    }
    return leaf;
}

export function pack(
    args: any[],
    pool: idPool,
    cbStore: Map<number, Function>,
    cbIds: number[],
): any[] {
    return args.map(v => walk(v, leaf => {
        if (typeof leaf == "function") {
            const id = pool.next();
            cbStore.set(id, leaf);
            cbIds.push(id);
            return { [FN_MARKER]: id };
        }
        return serializeLeaf(leaf);
    }));
}

export function packResult(value: any): any {
    return walk(value, leaf => serializeLeaf(leaf));
}

const _stopRegistry = new WeakMap<Function, () => void>();

export function rpcEndCallback(fn: Function) {
    _stopRegistry.get(fn)?.();
}

export function unpack(
    args: any[],
    sender: (id: number, a: any[]) => void,
    onEnd: (id: number) => void,
    lim?: Required<RpcLimits>,
): any[] {
    if (lim && args.length > lim.maxArgs) throw new PayloadLimitError("too many args");
    let cbCount = 0;
    return args.map(v => walk(v, leaf => {
        if (leaf != null && typeof leaf == "object" && leaf[FN_MARKER] !== undefined) {
            if (lim && ++cbCount > lim.maxCallbacks) throw new PayloadLimitError("too many callbacks");
            const id = leaf[FN_MARKER];
            if (typeof id !== "number" || !Number.isFinite(id)) throw new PayloadLimitError("invalid callback id");
            const wrapper = (...a: any[]) => {
                if (a[0] == RPC_STOP) { onEnd(id); return; }
                sender(id, a);
            };
            _stopRegistry.set(wrapper, () => onEnd(id));
            return wrapper;
        }
        return deserializeLeaf(leaf, undefined, lim);
    }, lim));
}

export function unpackResult(value: any, lim?: Required<RpcLimits>): any {
    return walk(value, leaf => deserializeLeaf(leaf, undefined, lim), lim);
}

// code/data/cause — аддитивные поля провода: старые клиенты их просто игнорируют,
// новые восстанавливают MyError (см. reviveErr в rpc-client).
export const errToObj = (e: any): any => {
    if (!(e instanceof Error)) return e;
    const o: any = { name: e.name, message: e.message, stack: e.stack };
    const { code, data, cause } = e as any;
    if (code !== undefined) o.code = code;
    // data ПАКУЕМ тем же rich-walk, что и обычный результат: иначе BigInt/Date/Map/Set
    // внутри data уходят сырыми в JSON.stringify на emit ошибки → throw ВНУТРИ catch →
    // вылетает мимо RPC try/catch → коннект убит. Симметрично распаковывается в reviveErr.
    // Для plain-JSON data packResult — identity (нет маркеров), старые пиры байт-в-байт.
    if (data !== undefined) o.data = packResult(data);
    if (cause !== undefined) o.cause = errToObj(cause);
    return o;
};

export const resolveCA = (path: string[], args: any[]): [string[], any[]] => {
    const last = path[path.length - 1];
    if (last == "call") return [path.slice(0, -1), args.slice(1)];
    if (last == "apply") return [path.slice(0, -1), args[1] ?? []];
    return [path, args];
};