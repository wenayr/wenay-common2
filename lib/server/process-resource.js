"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProcessResource = createProcessResource;
const node_child_process_1 = require("node:child_process");
const Listen_1 = require("../Common/events/Listen");
function createProcessResource(deps) {
    const startMs = deps.startTimeoutMs ?? 10_000;
    const stopMs = deps.stopTimeoutMs ?? 2000;
    const tailChars = deps.tailChars ?? 12_000;
    for (const value of [startMs, stopMs, tailChars]) {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new Error('invalid process resource limit');
    }
    if (deps.signal?.aborted)
        throw new Error('process start cancelled');
    const child = (0, node_child_process_1.spawn)(deps.command, [...deps.args ?? []], {
        cwd: deps.cwd, env: deps.env, windowsHide: true, shell: false,
        stdio: deps.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    const [emitFailure, failures] = (0, Listen_1.listen)();
    const [emitMessage, messages] = (0, Listen_1.listen)();
    let output = '';
    let ended = false;
    let prepared = false;
    let stopping;
    let failure;
    let resolveReady;
    let rejectReady;
    const ready = new Promise(function completion(resolve, reject) { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(function observed() { });
    let resolveDone;
    const done = new Promise(function completion(resolve) { resolveDone = resolve; });
    const deadline = setTimeout(function startupExpired() {
        fail(new Error('process startup timed out: ' + output));
        void close();
    }, startMs);
    function fail(error) {
        if (failure)
            return;
        failure = error;
        rejectReady(error);
        emitFailure(error);
    }
    function recognize(fact) {
        if (prepared || stopping || ended)
            return;
        try {
            const value = deps.ready(fact);
            if (value != undefined) {
                prepared = true;
                clearTimeout(deadline);
                resolveReady(value);
            }
        }
        catch (error) {
            fail(error);
            void close();
        }
    }
    function capture(type, chunk) {
        const value = chunk.toString();
        output = tailChars ? (output + value).slice(-tailChars) : '';
        recognize({ type, value, tail: output });
    }
    child.stdout?.on('data', function stdout(chunk) { capture('stdout', chunk); });
    child.stderr?.on('data', function stderr(chunk) { capture('stderr', chunk); });
    child.on('message', function message(value) { emitMessage(value); recognize({ type: 'message', value }); });
    child.once('error', function error(error) { fail(error); });
    child.once('close', function closed(code, signal) {
        ended = true;
        clearTimeout(deadline);
        deps.signal?.removeEventListener('abort', cancelled);
        if (!stopping)
            fail(new Error(`process exited (${code ?? signal}): ${output}`));
        rejectReady(new Error('process closed before readiness'));
        resolveDone();
        failures.close();
        messages.close();
    });
    function close() {
        if (stopping)
            return stopping;
        clearTimeout(deadline);
        rejectReady(new Error('process closed before readiness'));
        stopping = Promise.resolve().then(stop);
        return stopping;
    }
    async function stop() {
        if (ended)
            return;
        const force = setTimeout(function kill() { if (!ended)
            child.kill('SIGKILL'); }, stopMs);
        try {
            void Promise.resolve().then(function requestStop() {
                if (deps.shutdown)
                    return deps.shutdown(child);
                child.kill('SIGTERM');
            }).catch(function forceAfterFailure() { if (!ended)
                child.kill('SIGKILL'); });
            await done;
        }
        finally {
            clearTimeout(force);
        }
    }
    function cancelled() { void close(); }
    deps.signal?.addEventListener('abort', cancelled, { once: true });
    if (deps.signal?.aborted)
        cancelled();
    return {
        ready, done, close,
        events: { failure: { on: failures.on }, message: { on: messages.on } },
        view: { pid: () => child.pid, stopped: () => ended, output: () => output, failure: () => failure },
    };
}
