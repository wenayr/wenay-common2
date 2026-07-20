
// Error with machine code and arbitrary payload; serializable for RPC.
// Small test comment: logic below was intentionally not changed.
export class MyError<D = unknown> extends Error {
    override name = 'MyError'

    constructor(message: string, readonly code = 'ERR', readonly data = {} as D, cause?: unknown) {
        super(message)
        if (cause != undefined) (this as any).cause = cause
    }

    toJSON() {
        const {name, message, code, data, stack} = this
        return {name, message, code, data, stack}
    }

    // convert any value to Error without throwing (non-Error goes to data.value)
    static wrap(e: unknown) {
        return e instanceof Error ? e : new MyError(typeof e == 'string' ? e : JSON.stringify(e), 'ERR', {value: e})
    }

    static fromWire<D>(w: tWire<D>) {
        return Object.assign(new MyError<D>(w.message, w.code, w.data), {name: w.name, stack: w.stack})
    }
}

// wire type derived from implementation, not duplicated manually
export type tWire<D = unknown> = ReturnType<MyError<D>['toJSON']>

// ===========================================================================
// toError — public legacy export: behavior and signatures must not change,
// so left as-is, awkward members only marked @deprecated.
// ===========================================================================

const legacyThrow = (e: any): never => {
    if (e instanceof Error) throw e
    throw new Error(JSON.stringify(e))
}

export const toError = {
    /** @deprecated setter-throw is counterintuitive; use {@link toError.throw} or {@link MyError.wrap} */
    set convert(e: any){ legacyThrow(e) },
    throw(e: any){ legacyThrow(e) },
    /** @deprecated essentially identity; use {@link MyError.wrap} */
    convertToMsg(e: any){ return e },
}
