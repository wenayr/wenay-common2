"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIterableObject = createIterableObject;
function createIterableObject(options) {
    const { resolve, onChange } = options;
    return new Proxy({}, {
        get(_, key) {
            if (key === Symbol.iterator)
                return () => resolve()[Symbol.iterator]();
            if (typeof key === "string")
                return resolve().get(key);
        },
        set(_, key, value) {
            if (!onChange || typeof key !== "string")
                return true;
            onChange("set", key, value);
            return true;
        },
        deleteProperty(_, key) {
            if (!onChange || typeof key !== "string")
                return true;
            onChange("delete", key);
            return true;
        },
        has(_, key) {
            return typeof key === "string" && resolve().has(key);
        },
        ownKeys() {
            return [...resolve().keys()];
        },
        getOwnPropertyDescriptor(_, key) {
            if (typeof key === "string" && resolve().has(key)) {
                return {
                    configurable: true,
                    enumerable: true,
                    writable: !!onChange,
                    value: resolve().get(key)
                };
            }
        }
    });
}
function test2() {
    const storage = new Map();
    storage.set("a", 1);
    const ro = createIterableObject({ resolve: () => storage });
    for (const [k, v] of ro) {
        console.log(ro[k], k, v);
    }
    const rw = createIterableObject({
        resolve: () => storage,
        onChange(type, key, value) {
            if (type === "set")
                storage.set(key, value);
            if (type === "delete")
                storage.delete(key);
            console.log(`[${type}] ${key}`, value);
        }
    });
    rw["b"] = 2;
    delete rw["a"];
    for (const [k, v] of rw) {
        console.log(k, v);
        rw["c"] = 3;
    }
}
