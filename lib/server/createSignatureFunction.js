"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignatureFunction = createSignatureFunction;
function createSignatureFunction(hmacCreator) {
    return function signRequest(params, apiSecret) {
        const query = Object.keys(params)
            .reduce((accumulator, key) => {
            const value = params[key];
            if (Array.isArray(value)) {
                value.forEach(v => {
                    accumulator.push(key + "=" + encodeURIComponent(v));
                });
            }
            else if (value !== undefined) {
                accumulator.push(key + "=" + encodeURIComponent(value));
            }
            return accumulator;
        }, [])
            .join("&");
        return hmacCreator('sha256', apiSecret).update(query).digest('hex');
    };
}
