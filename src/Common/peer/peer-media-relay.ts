// =====================================================================
// Media relay — per-account named media lines on the host (relay-first)
// =====================================================================
// Formalizes the demo stand's media hub: browser capture originates on the
// CLIENT, so the server side is a tiny relay of replay lines. 'video' lines
// are keep-latest (a late joiner instantly gets the last frame), 'audio' is
// a short lossless queue. Frames ride as [frame, sentAt] — the wall-clock
// publish stamp feeds viewer latency stats (Media.attach* helpers read it).
// Exposure follows the peers-map pattern: `watch` is a noStrict dynamic map
// {account: {line: replay line}} — spread it into an rpc object as is.
// Route note: media rides the socket relay BY DESIGN (mainstream messengers
// route calls through their servers too) — this is the privacy default;
// direct paths stay a separate, policy-gated opt-in.

import {ListenReplayApi, replayListen} from '../events/replay-listen'
import {noStrict} from '../rcp/rpc-dynamic'

export type tMediaRelayKind = 'video' | 'audio'

/** Watch policy: may `watcher` see `owner`'s `line`? Evaluated on EVERY path resolution (subscribe/keyframe). */
export type tCanWatch = (watcher: string, owner: string, line: string) => boolean

export type MediaRelayDeps = {
    /** Line registry: name -> semantics, e.g. {cam: 'video', mic: 'audio', screen: 'video'}. */
    lines: Record<string, tMediaRelayKind>
    /** Keep-latest ring for video lines (late joiner cost). */
    videoHistory?: number
    /** Short lossless queue for audio lines. */
    audioHistory?: number
    /**
     * Watch ACL for `watchOf(...)` views. Omitted = open relay (everyone sees everyone).
     * The policy gates both path resolution and every forwarded live frame/keyframe.
     * An already-open subscription stays allocated after revocation but receives no data.
     */
    canWatch?: tCanWatch
}

type tMediaFrame = [unknown, number]
type tRelayLine = ListenReplayApi<tMediaFrame>

export function createMediaRelay(deps: MediaRelayDeps) {
    const {lines, videoHistory = 8, audioHistory = 64, canWatch} = deps
    type AccountLines = {emits: Record<string, (frame: unknown, sentAt: number) => void>, view: Record<string, tRelayLine>}
    const accounts = new Map<string, AccountLines>()
    // dynamic keyspace: accounts appear at runtime, watchers resolve them by string path
    const watch: Record<string, Record<string, tRelayLine>> = noStrict({})

    function makeLine(kind: tMediaRelayKind) {
        return kind == 'video'
            ? replayListen<tMediaFrame>({
                history: videoHistory, current: 'last',
                frame: function lastFrameOnly(tail) { return tail.length ? [tail[tail.length - 1]] : [] },
            })
            : replayListen<tMediaFrame>({history: audioHistory})
    }

    function linesOf(account: string) {
        let entry = accounts.get(account)
        if (!entry) {
            entry = {emits: {}, view: noStrict({})}
            for (const name of Object.keys(lines)) {
                const [emit, api] = makeLine(lines[name])
                entry.emits[name] = emit
                entry.view[name] = api
            }
            accounts.set(account, entry)
            watch[account] = entry.view
        }
        return entry
    }

    /** The publishing side: wire as `media.publish` in that account's rpc fragment. */
    function publishOf(account: string) {
        // eager: the account's lines must exist BEFORE the first frame, so watchers
        // can resolve watch[account] the moment the connection is up (peers-map rule)
        linesOf(account)
        return function publish(line: string, frame: unknown, sentAt: number) {
            // re-resolve per frame: a dropAccount'ed account revives on its next publish
            linesOf(account).emits[line]?.(frame, sentAt)
        }
    }

    // ============== policy-gated watch views (per watcher) ==============
    // The rpc dynamic walk does `seg in curr` + `curr[seg]` on every call, so a Proxy's
    // has/get traps ARE the ACL point: canWatch runs at each NEW resolution (subscribe,
    // keyframe, frame), which lets media access follow call state. Views are cached per
    // (watcher, owner) so the wire sees stable node identities.
    type WatcherCache = {
        root: Record<string, Record<string, tRelayLine>>
        owners: Map<string, Record<string, tRelayLine>>
        filtered: Set<tRelayLine>
    }
    const watcherViews = new Map<string, WatcherCache>()

    function allowed(watcher: string, owner: string, line: string) {
        return canWatch ? canWatch(watcher, owner, line) : true
    }

    function filteredLine(watcher: string, owner: string, name: string, source: tRelayLine, cache: WatcherCache) {
        const [emit, filtered] = replayListen<tMediaFrame>({
            history: lines[name] == 'video' ? videoHistory : audioHistory,
            current: function currentIfAllowed() {
                return allowed(watcher, owner, name) ? source.keyframe()?.event : undefined
            },
            ...(lines[name] == 'video' ? {
                frame: function lastAllowedFrame(tail: Array<{seq: number, ts: number, event: tMediaFrame}>) {
                    return tail.length ? [tail[tail.length - 1]] : []
                },
            } : {}),
        })
        const offSource = source.on(function forwardAllowed(frame, sentAt) {
            if (allowed(watcher, owner, name)) emit(frame, sentAt)
        })
        const closeFiltered = filtered.close
        filtered.close = function closePolicyLine() {
            offSource()
            closeFiltered()
        }
        cache.filtered.add(filtered)
        return filtered
    }

    function ownerViewFor(watcher: string, owner: string, cache: WatcherCache) {
        let view = cache.owners.get(owner)
        if (view) return view
        const entry = accounts.get(owner)
        if (!entry) return undefined
        const policyLines: Record<string, tRelayLine> = {}
        for (const name of Object.keys(lines)) policyLines[name] = filteredLine(watcher, owner, name, entry.view[name], cache)
        view = noStrict(new Proxy(policyLines, {
            has(t, k) { return typeof k == 'string' && k in t && allowed(watcher, owner, k) },
            get(t, k) {
                if (typeof k != 'string') return (t as any)[k]
                return k in t && allowed(watcher, owner, k) ? t[k] : undefined
            },
        }))
        cache.owners.set(owner, view)
        return view
    }

    /**
     * Per-connection watch surface: wire as `media.watch` with THIS connection's account —
     * that identity is what `canWatch` receives. Without `canWatch` behaves like `watch`.
     */
    function watchOf(watcher: string) {
        let cached = watcherViews.get(watcher)
        if (cached) return cached.root
        const owners = new Map<string, Record<string, tRelayLine>>()
        const filtered = new Set<tRelayLine>()
        // an owner key is visible only when the account exists AND at least one line passes
        function visible(owner: string) {
            return accounts.has(owner) && Object.keys(lines).some(name => allowed(watcher, owner, name))
        }
        const root = noStrict(new Proxy({} as Record<string, Record<string, tRelayLine>>, {
            has(_t, k) { return typeof k == 'string' && visible(k) },
            get(_t, k) {
                if (typeof k != 'string') return undefined
                return visible(k) ? ownerViewFor(watcher, k, cached!) : undefined
            },
        }))
        cached = {root, owners, filtered}
        watcherViews.set(watcher, cached)
        return root
    }

    function dropLines(entry: AccountLines) {
        for (const name of Object.keys(entry.view)) entry.view[name].close()
    }

    function closeWatcherCache(cache: WatcherCache) {
        for (const line of cache.filtered) line.close()
        cache.filtered.clear()
        cache.owners.clear()
    }

    /** Retire an account: close its lines (live watchers end LOUDLY) and free the keyspace. */
    function dropAccount(account: string) {
        const entry = accounts.get(account)
        const ownCache = watcherViews.get(account)
        if (ownCache) closeWatcherCache(ownCache)
        watcherViews.delete(account)
        for (const cache of watcherViews.values()) {
            const ownerView = cache.owners.get(account)
            if (ownerView) for (const line of Object.values(ownerView)) {
                line.close()
                cache.filtered.delete(line)
            }
            cache.owners.delete(account)
        }
        if (!entry) return
        accounts.delete(account)
        delete watch[account]
        dropLines(entry)
    }

    return {
        publishOf,
        /** UNFILTERED watcher surface {account: {line}} — trusted wiring only; prefer watchOf. */
        watch,
        watchOf,
        /** Pre-create an account's lines (optional — publish creates them lazily). */
        lines: (account: string) => linesOf(account).view,
        accounts: () => Array.from(accounts.keys()),
        dropAccount,
        close() {
            for (const cache of watcherViews.values()) closeWatcherCache(cache)
            for (const entry of accounts.values()) dropLines(entry)
            accounts.clear()
            watcherViews.clear()
        },
    }
}

export type MediaRelay = ReturnType<typeof createMediaRelay>
