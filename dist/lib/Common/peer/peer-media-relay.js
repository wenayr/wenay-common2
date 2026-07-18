"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMediaRelay = createMediaRelay;
const replay_listen_1 = require("../events/replay-listen");
const rpc_dynamic_1 = require("../rcp/rpc-dynamic");
function createMediaRelay(deps) {
    const { lines, videoHistory = 8, audioHistory = 64, canWatch } = deps;
    const accounts = new Map();
    const watch = (0, rpc_dynamic_1.noStrict)({});
    function makeLine(kind) {
        return kind == 'video'
            ? (0, replay_listen_1.replayListen)({
                history: videoHistory, current: 'last',
                frame: function lastFrameOnly(tail) { return tail.length ? [tail[tail.length - 1]] : []; },
            })
            : (0, replay_listen_1.replayListen)({ history: audioHistory });
    }
    function linesOf(account) {
        let entry = accounts.get(account);
        if (!entry) {
            entry = { emits: {}, view: (0, rpc_dynamic_1.noStrict)({}) };
            for (const name of Object.keys(lines)) {
                const [emit, api] = makeLine(lines[name]);
                entry.emits[name] = emit;
                entry.view[name] = api;
            }
            accounts.set(account, entry);
            watch[account] = entry.view;
        }
        return entry;
    }
    function publishOf(account) {
        linesOf(account);
        return function publish(line, frame, sentAt) {
            linesOf(account).emits[line]?.(frame, sentAt);
        };
    }
    const watcherViews = new Map();
    function allowed(watcher, owner, line) {
        return canWatch ? canWatch(watcher, owner, line) : true;
    }
    function filteredLine(watcher, owner, name, source, cache) {
        const [emit, filtered] = (0, replay_listen_1.replayListen)({
            history: lines[name] == 'video' ? videoHistory : audioHistory,
            current: function currentIfAllowed() {
                return allowed(watcher, owner, name) ? source.keyframe()?.event : undefined;
            },
            ...(lines[name] == 'video' ? {
                frame: function lastAllowedFrame(tail) {
                    return tail.length ? [tail[tail.length - 1]] : [];
                },
            } : {}),
        });
        const offSource = source.on(function forwardAllowed(frame, sentAt) {
            if (allowed(watcher, owner, name))
                emit(frame, sentAt);
        });
        const closeFiltered = filtered.close;
        filtered.close = function closePolicyLine() {
            offSource();
            closeFiltered();
        };
        cache.filtered.add(filtered);
        return filtered;
    }
    function ownerViewFor(watcher, owner, cache) {
        let view = cache.owners.get(owner);
        if (view)
            return view;
        const entry = accounts.get(owner);
        if (!entry)
            return undefined;
        const policyLines = {};
        for (const name of Object.keys(lines))
            policyLines[name] = filteredLine(watcher, owner, name, entry.view[name], cache);
        cache.ownerLines.set(owner, new Set(Object.values(policyLines)));
        view = (0, rpc_dynamic_1.noStrict)(new Proxy(policyLines, {
            has(t, k) { return typeof k == 'string' && k in t && allowed(watcher, owner, k); },
            get(t, k) {
                if (typeof k != 'string')
                    return t[k];
                return k in t && allowed(watcher, owner, k) ? t[k] : undefined;
            },
        }));
        cache.owners.set(owner, view);
        return view;
    }
    function watchOf(watcher) {
        let cached = watcherViews.get(watcher);
        if (cached)
            return cached.root;
        const owners = new Map();
        const ownerLines = new Map();
        const filtered = new Set();
        function visible(owner) {
            return accounts.has(owner) && Object.keys(lines).some(name => allowed(watcher, owner, name));
        }
        const root = (0, rpc_dynamic_1.noStrict)(new Proxy({}, {
            has(_t, k) { return typeof k == 'string' && visible(k); },
            get(_t, k) {
                if (typeof k != 'string')
                    return undefined;
                return visible(k) ? ownerViewFor(watcher, k, cached) : undefined;
            },
        }));
        cached = { root, owners, ownerLines, filtered };
        watcherViews.set(watcher, cached);
        return root;
    }
    function dropLines(entry) {
        for (const name of Object.keys(entry.view))
            entry.view[name].close();
    }
    function closeWatcherCache(cache) {
        for (const line of cache.filtered)
            line.close();
        cache.filtered.clear();
        cache.owners.clear();
        cache.ownerLines.clear();
    }
    function dropAccount(account) {
        const entry = accounts.get(account);
        const ownCache = watcherViews.get(account);
        if (ownCache)
            closeWatcherCache(ownCache);
        watcherViews.delete(account);
        for (const cache of watcherViews.values()) {
            const ownerLines = cache.ownerLines.get(account);
            if (ownerLines)
                for (const line of ownerLines) {
                    line.close();
                    cache.filtered.delete(line);
                }
            cache.owners.delete(account);
            cache.ownerLines.delete(account);
        }
        if (!entry)
            return;
        accounts.delete(account);
        delete watch[account];
        dropLines(entry);
    }
    return {
        publishOf,
        watch,
        watchOf,
        lines: (account) => linesOf(account).view,
        accounts: () => Array.from(accounts.keys()),
        dropAccount,
        close() {
            for (const cache of watcherViews.values())
                closeWatcherCache(cache);
            for (const entry of accounts.values())
                dropLines(entry);
            accounts.clear();
            watcherViews.clear();
        },
    };
}
