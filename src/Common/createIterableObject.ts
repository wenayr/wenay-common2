type IterableObjectOptions<V> = {
    resolve: () => Map<string, V>
    /** если передан — включает запись, вызывается при set/delete */
    onChange?: (type: "set" | "delete", key: string, value?: V) => void
}

function createIterableObject<V>(
    options: IterableObjectOptions<V>
): Iterable<[string, V]> & Record<string, V> {
    const { resolve, onChange } = options

    return new Proxy({} as any, {
        get(_, key: string | symbol) {
            if (key === Symbol.iterator)
                return () => resolve()[Symbol.iterator]()
            if (typeof key === "string")
                return resolve().get(key)
        },

        set(_, key: string | symbol, value: V) {
            if (!onChange || typeof key !== "string") return false
            onChange("set", key, value)
            return true
        },

        deleteProperty(_, key: string | symbol) {
            if (!onChange || typeof key !== "string") return false
            onChange("delete", key)
            return true
        },

        has(_, key: string | symbol) {
            return typeof key === "string" && resolve().has(key)
        },

        ownKeys() {
            return [...resolve().keys()]
        },

        getOwnPropertyDescriptor(_, key: string | symbol) {
            if (typeof key === "string" && resolve().has(key)) {
                return {
                    configurable: true,
                    enumerable: true,
                    writable: !!onChange,
                    value: resolve().get(key)
                }
            }
        }
    })
}


function test2() {
    const storage = new Map<string, number>()
    storage.set("a", 1)
    // ── Readonly ──
    const ro = createIterableObject({ resolve: () => storage })

    for (const [k, v] of ro) {
        console.log(ro[k], k, v) // 1 "a" 1
    }

    // ── Read-Write с observable ──
    const rw = createIterableObject({
        resolve: () => storage,
        onChange(type, key, value) {
            if (type === "set") storage.set(key, value!)
            if (type === "delete") storage.delete(key)
            console.log(`[${type}] ${key}`, value)
        }
    })

    rw["b"] = 2          // [set] b 2
    delete rw["a"]       // [delete] a

    for (const [k, v] of rw) {
        console.log(k, v) // "b" 2
        rw["c"] = 3       // safe — Map гарантирует видимость
    }
    // "c" 3 — тоже выведется
}