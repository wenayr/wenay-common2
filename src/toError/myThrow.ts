
// Ошибка с машинным кодом и произвольной нагрузкой; сериализуема для RPC.
// Небольшой тестовый комментарий: логика ниже намеренно не менялась.
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

    // привести любое значение к Error, не бросая (не-Error уходит в data.value)
    static wrap(e: unknown) {
        return e instanceof Error ? e : new MyError(typeof e == 'string' ? e : JSON.stringify(e), 'ERR', {value: e})
    }

    static fromWire<D>(w: tWire<D>) {
        return Object.assign(new MyError<D>(w.message, w.code, w.data), {name: w.name, stack: w.stack})
    }
}

// проводной тип выводим из реализации, а не дублируем руками
export type tWire<D = unknown> = ReturnType<MyError<D>['toJSON']>

// ===========================================================================
// toError — публичный легаси-экспорт: поведение и сигнатуры менять нельзя,
// поэтому оставлено как было, awkward-члены лишь помечены @deprecated.
// ===========================================================================

const legacyThrow = (e: any): never => {
    if (e instanceof Error) throw e
    throw new Error(JSON.stringify(e))
}

export const toError = {
    /** @deprecated сеттер-бросок неинтуитивен; используй {@link toError.throw} или {@link MyError.wrap} */
    set convert(e: any){ legacyThrow(e) },
    throw(e: any){ legacyThrow(e) },
    /** @deprecated по сути identity; используй {@link MyError.wrap} */
    convertToMsg(e: any){ return e },
}
