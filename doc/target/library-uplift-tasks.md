# Library Uplift Tasks (surface, SDK, demo)

Goal: stop measuring progress by transport layers added; measure by what can be shown working.
The transport/routing/replay lower half is built and oracle-covered (52/52) — the missing value is
the consumption layer: showcase hygiene, one happy-path SDK facade, and one vertical demo app that
becomes the library's portfolio and its source of real API pain.

Priority order: 1 -> 2 -> 3 -> 4. Transport items are NOT forbidden — see the deferred section.

## Tasks

- [x] 1. Showcase hygiene (v1.0.69):
  - [x] GitHub Actions CI: `.github/workflows/ci.yml` (windows-latest: npm scripts use cmd syntax) —
        build + publish gate + full oracle suite; badge in `README.md`
  - [x] new code comments in English going forward (existing Russian comments stay until touched)
  - note: `dist/`/`lib/` are deliberately NOT gitignored — committed output doubles as a usage example
- [x] 2. SDK facade — one entry point (core shipped in v1.0.69 as the `Peer` namespace):
  - [x] MUST interop with legacy code (at least temporarily): server side is an object FRAGMENT
        spread into an EXISTING `createRpcServerAuto` object (old keys untouched); client side
        takes the existing deep proxy (`clients.api.func`) — no parallel world, additive only
  - [x] `createPeerHost` (server): signal hub + per-account patch relay journals (owner seq space,
        so relay and direct share coordinates) + `peers: noStrict(map)` dynamic feed
  - [x] `createPeerClient` (client): own store published to the relay, `peer(account)` -> mirrored
        store + route link (relay by default, `promoteDirect()` when `rtc` factory is given)
  - [x] acceptance: "two accounts see each other's store and can promote to direct" is ~10 user
        lines, not ~60; legacy rpc keys on the same connection keep working
        (`replay/peer-sdk.test.ts`, incl. same-seq-space hand-off — no keyframe reset)
  - rare.md audit: DROPPED by the author — rare.md is deliberately the complete reference and must
        ship in the npm package for AI convenience; nothing to demote
  - React byRender-emulation (callback-by-map with a micro-pause, register+invoke pair): DROPPED by
        the author as bad style; the chunked/each feeds are enough for the React-layer hooks
- [ ] 3. Vertical demo app (1-2 weeks) — the forcing function:
  - note: a canvas showcase already exists in the React layer (hooks are being added there);
        this demo should CONSUME the SDK facade and feed React-layer hook needs back into task 2
  - [x] shared canvas / cursors in two browser tabs: `demo/` (`npm run demo`) — Peer SDK next to a
        legacy rpc key, real RTCPeerConnection, "Go direct" / "Back to relay" buttons, signaling log.
        VERIFIED in Chrome: relay mirroring -> direct promotion -> manual re-interposition, cursor
        never jumps, seq continues across both hand-offs (no keyframe reset); found and fixed a real
        library bug on the way (RTCIceCandidate must ride as toJSON init — class instances get
        mangled by transport serialization)
  - [x] messenger-style calls in the demo (v1.0.74): presence indicator, ring/accept/decline/hangup,
        peer media attaches ONLY while the call is active (watch ACL maintained by a tiny server-owned
        call lifecycle inside the host `authorize` hook). VERIFIED headless (two Chromium tabs, fake cam):
        ring -> accept -> frames -> hangup -> decline, zero page errors. Found and fixed two real
        library bugs on the way (pain-point loop works): subscribe-before-owner race in the `peers`
        map (now auto-creates an empty journal); `viewer.off()` threw on rpc-projected lines
  - [ ] closes webrtc-route-coordinator step 10 as a byproduct: `rtc: () => new RTCPeerConnection(cfg)`
        glue + media re-emit into the `Media` `Listen`/replay surface
  - [ ] closes step 7 app-first: account map (`noStrict(accountMap)`) + `createStoreManager`
        lifecycle written as app code; promote into the library only if it generalizes
  - [ ] README GIF: stream migrating relay -> direct with zero dropped frames
  - [ ] collect real API pain points -> next roadmap items come from here, not speculation
- [ ] 4. Authority layer (`predictedStore`, ROADMAP section 3) — only AFTER the demo demands it;
      the demo defines its shape and keeps it small.

## Transport — deferred (super-low priority, NOT blocked)

No hard freeze: any item below may be picked up at will, it just ranks below everything above.
The natural reopen trigger is a real consumer (SDK/demo) hitting a wall.

- CRDT / symmetric co-write adapter (ROADMAP section 3, third bullet)
- transfer/perf backlog: tighter frames, delta minimization, binary framing, batching (ROADMAP section 4)
- coordinated fan-out / lockstep broadcast (ROADMAP section 2 — already shelved)
- group topology beyond a pair of accounts; multi-hop backpressure; auth continuity across route swap
- remaining route-coordinator open questions in `doc/ROADMAP.md` section 0.1

## Rationale (why this order)

Transport has no natural "done" — it is asymptotic; apps have "done". Every layer added spawns two
more roadmap items, while the library has zero real consumers besides oracles. The SDK facade kills
the "surface is unliftable" feeling; the demo turns the stack into a portfolio piece and generates
grounded priorities. Fix the storefront, not the engine — the engine is already better than most
production systems.

## Next Action

Finish task 3: capture the relay -> direct README GIF, then feed the remaining real demo pain points
into the React consumption layer. Keep authority/CRDT work deferred until a consumer demands it.
