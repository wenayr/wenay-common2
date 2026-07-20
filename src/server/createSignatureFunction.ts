export type MilliSec = number

type tInputBaseR = {
    [key: string]: boolean | number | string | string[]
}

export type tInputBase = {
    timestamp?: MilliSec
    recvWindow?: MilliSec
} & tInputBaseR

type tSignatureData = tInputBase

type HmacCreator = (algorithm: string, key: string) => {
    update: (data: string) => { digest: (encoding: string) => unknown }
}

export function createSignatureFunction<T extends HmacCreator>(hmacCreator: T) {
    /**
     * Signs params as query string IN KEY INSERTION ORDER (Object.keys).
     * CONTRACT: the calling code must build real request bytes THE SAME WAY —
     * same key order and encodeURIComponent, otherwise signature won't match.
     * Order here cannot be changed: sorting would break signatures of existing consumers.
     */
    return function signRequest(params: tSignatureData, apiSecret: string) {
        const query = Object.keys(params)
            .reduce((accumulator: string[], key) => {
                const value = params[key]
                if (Array.isArray(value)) {
                    value.forEach(v => {
                        accumulator.push(key + "=" + encodeURIComponent(v))
                    })
                } else if (value !== undefined) {
                    accumulator.push(key + "=" + encodeURIComponent(value))
                }
                return accumulator
            }, [])
            .join("&")

        return hmacCreator('sha256', apiSecret).update(query).digest('hex')
    }
}

export type SignatureFunction = ReturnType<typeof createSignatureFunction>