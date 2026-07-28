"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMediaRoute = createMediaRoute;
const Listen_1 = require("../events/Listen");
const route_coordinator_1 = require("../events/route-coordinator");
function unsubscribeHandle(handle) {
    if (typeof handle == 'function')
        handle();
    else if (typeof handle?.off == 'function')
        handle.off();
    else
        handle?.unsubscribe?.();
}
function createMediaRoute(deps) {
    const { self, peer, connect, policy, shadow, catchUpTimeoutMs, directRetryMs = 5_000, } = deps;
    const coordinator = (0, route_coordinator_1.createRouteCoordinator)({ connect, policy, shadow, catchUpTimeoutMs });
    let link = coordinator.pair(self, peer);
    const [emitFrame, line] = (0, Listen_1.listen)();
    const [emitChange, changed] = (0, Listen_1.listen)();
    let mode = deps.mode ?? 'relay';
    let stage = 'idle';
    let error;
    let offLine = null;
    let directReady = false;
    let retryTimer = null;
    let opChain = Promise.resolve();
    let resetting = false;
    let previous = {
        mode,
        state: 'idle',
        active: null,
        label: null,
    };
    function activeRoute() {
        if (stage == 'idle' || stage == 'starting' || stage == 'closed')
            return null;
        const routeState = link.state();
        const direct = directReady && (routeState == 'direct' || routeState == 'direct+shadowRelay');
        if (mode == 'direct')
            return direct ? 'direct' : null;
        return direct ? 'direct' : 'relay';
    }
    function status() {
        const active = activeRoute();
        return {
            mode,
            state: stage == 'idle' ? 'idle'
                : stage == 'starting' ? 'starting'
                    : stage == 'closed' ? 'closed'
                        : link.state(),
            active,
            label: active ? link.label() : null,
            ...(error == undefined ? {} : { error }),
        };
    }
    function sameStatus(a, b) {
        return a.mode == b.mode && a.state == b.state && a.active == b.active &&
            a.label == b.label && a.error == b.error;
    }
    function publish(reason) {
        const current = status();
        if (sameStatus(previous, current) && reason == undefined)
            return;
        const before = previous;
        previous = current;
        emitChange({ previous: before, current, reason });
    }
    function forwardFrame(...event) {
        if (mode == 'direct' && activeRoute() != 'direct')
            return;
        const send = emitFrame;
        send(...event);
    }
    async function replaceSubscription() {
        unsubscribeHandle(offLine);
        offLine = link.subscribe(forwardFrame);
        await offLine.ready;
    }
    async function ensureSubscription() {
        if (offLine)
            return;
        offLine = link.subscribe(forwardFrame);
        await offLine.ready;
    }
    function resetLink() {
        resetting = true;
        unsubscribeHandle(offLine);
        offLine = null;
        link.close();
        link = coordinator.pair(self, peer);
        directReady = false;
        resetting = false;
    }
    function cancelRetry() {
        if (retryTimer)
            clearTimeout(retryTimer);
        retryTimer = null;
    }
    function shouldRetry(reason) {
        return !(typeof reason == 'string' && reason.startsWith('policy:'));
    }
    function scheduleBestRetry(reason) {
        if (stage != 'started' || mode != 'best' || directRetryMs == false || retryTimer ||
            !shouldRetry(reason))
            return;
        retryTimer = setTimeout(function retryBestDirect() {
            retryTimer = null;
            void reconsider('best retry');
        }, Math.max(0, directRetryMs));
    }
    async function promote(reason) {
        directReady = false;
        try {
            const result = await link.promoteDirect({ reason });
            if (!result.ok) {
                error = result.reason;
                if (mode == 'best')
                    scheduleBestRetry(result.reason);
                publish(result.reason);
                return status();
            }
            error = undefined;
            cancelRetry();
            if (mode == 'direct')
                await replaceSubscription();
            directReady = true;
            publish(reason);
            return status();
        }
        catch (nextError) {
            directReady = false;
            error = nextError;
            if (mode == 'direct') {
                resetLink();
            }
            else if (link.state() == 'direct' || link.state() == 'direct+shadowRelay') {
                try {
                    await link.fallback(nextError);
                }
                catch { }
            }
            if (mode == 'best')
                scheduleBestRetry(nextError);
            publish(nextError);
            return status();
        }
    }
    async function applyMode(reason) {
        if (mode == 'relay') {
            cancelRetry();
            directReady = false;
            const result = await link.reinterposeRelay(reason);
            error = result.ok ? undefined : result.reason;
            publish(result.reason ?? reason);
            return status();
        }
        return promote(reason);
    }
    function chained(run) {
        const task = opChain.then(run, run);
        opChain = task.catch(() => { });
        return task;
    }
    async function start() {
        return chained(async function startMediaRoute() {
            if (stage == 'closed')
                throw new Error('media route is closed');
            if (stage == 'started')
                return status();
            stage = 'starting';
            error = undefined;
            publish('start');
            if (mode == 'direct') {
                stage = 'started';
                publish('direct start');
                return promote('start');
            }
            try {
                await ensureSubscription();
                stage = 'started';
                publish('relay ready');
                return await applyMode('start');
            }
            catch (nextError) {
                stage = 'started';
                error = nextError;
                publish(nextError);
                if (mode == 'best')
                    return promote('relay unavailable');
                return status();
            }
        });
    }
    async function setMode(next) {
        return chained(async function setMediaRouteMode() {
            if (stage == 'closed')
                throw new Error('media route is closed');
            if (mode == next && stage == 'started')
                return status();
            mode = next;
            error = undefined;
            publish('mode');
            if (stage != 'started')
                return status();
            if ((mode == 'relay' || mode == 'best') && !offLine) {
                try {
                    await ensureSubscription();
                }
                catch (nextError) {
                    error = nextError;
                    publish(nextError);
                    if (mode == 'best')
                        return promote('relay unavailable');
                    return status();
                }
            }
            return applyMode('mode');
        });
    }
    async function reconsider(reason) {
        return chained(async function reconsiderMediaRoute() {
            if (stage == 'closed')
                throw new Error('media route is closed');
            if (stage != 'started')
                return status();
            if (mode == 'relay')
                return status();
            return promote(reason);
        });
    }
    const offRoute = coordinator.onRoute(function onUnderlyingRoute(event) {
        if (resetting || event.key != link.ref.key || stage == 'closed')
            return;
        if (event.to == 'fallback' || event.to == 'relay' || event.to == 'blocked')
            directReady = false;
        if (event.to == 'fallback' && mode == 'best')
            scheduleBestRetry(event.reason);
        if (event.to == 'fallback' && mode == 'direct')
            error = event.reason;
        publish(event.reason);
    });
    function close() {
        if (stage == 'closed')
            return;
        cancelRetry();
        stage = 'closed';
        unsubscribeHandle(offLine);
        offLine = null;
        unsubscribeHandle(offRoute);
        coordinator.close();
        publish('close');
        line.close();
        changed.close();
    }
    return {
        control: {
            start,
            setMode,
            reconsider,
            close,
        },
        resource: {
            line,
        },
        events: {
            changed,
        },
        view: {
            status,
            mode: () => mode,
            route: activeRoute,
            metrics: () => link.metrics(),
        },
    };
}
