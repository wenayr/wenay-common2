// The watched development module for the demo stand.
//
// Edit and save this file while `npm run demo` runs with DEMO_DEV_MODULE=1.
// The next call runs the new code: no restart, no registration, no descriptors.
// Add a method here and it is immediately listed by /dev-module/methods and
// callable at /dev-module/call/<name>.
//
// The factory receives a context and returns an object of methods. Each method
// gets (input, call); `call` carries signal, bindingGeneration and correlationId.

function createDemoDevModule() {
    return {
        'health.warmup'() {
            return {ok: true}
        },
        'health.check'() {
            return {ok: true}
        },

        greet(input, call) {
            const name = typeof input == 'string' ? input : input?.name ?? 'world'
            return {
                ok: true,
                message: 'hello, ' + name,
                bindingGeneration: call.bindingGeneration,
            }
        },

        sum(input) {
            const values = Array.isArray(input) ? input : input?.values
            if (!Array.isArray(values)) return {ok: false, error: 'expected an array of numbers'}
            return {ok: true, total: values.reduce((total, value) => total + Number(value), 0)}
        },
    }
}
