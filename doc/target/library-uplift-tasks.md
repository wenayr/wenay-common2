# Library Uplift Tasks (surface, SDK, resource layer)

Goal: stop measuring progress by transport layers added; measure by what can be shown working.
The transport/routing/replay lower half is built and covered by the full oracle suite — the missing value is
the consumption layer: showcase hygiene, one happy-path SDK facade, and a small vertical resource
layer that proves the library against a real frontend ↔ backend/AI workflow.

Priority order was 1 -> 2 -> 3. Transport items are NOT forbidden — see the deferred section.

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
- [x] 3. Vertical demo app — the forcing function:
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
  - [x] closes webrtc-route-coordinator step 10 as a byproduct: `rtc: () => new RTCPeerConnection(cfg)`
        glue + byte-preserving media re-emit into the `Media` `Listen`/replay surface (v1.0.76)
  - [x] closes step 7 app-first: account map (`noStrict(accountMap)`) + `createStoreManager`
        lifecycle written as app code; promote into the library only if it generalizes (v1.0.76)
  - [🧊] README GIF: stream migrating relay -> direct with zero dropped frames. Optional storefront
        asset, not a library delivery requirement.
  - [x] collect real API pain points -> next roadmap items come from here, not speculation
        (v1.0.76: direct replay JSON corrupted `Media` `Uint8Array`; fixed with a portable binary codec)
- [x] 4. File resource + AI job coordinator (v1.0.77):
  - [x] `Resource.createFileJobHost`: injected storage intent port (`beginUpload` / optional
        `confirmUpload` / optional `download`), injected cancellable AI runner, owner-only default
        ACL and per-connection filtered `Store`/replay state.
  - [x] `Resource.createFileJobClient`: one local mirror with upload -> direct storage -> confirm ->
        job progress/result/cancel lifecycle; existing RPC keys remain untouched.
  - [x] acceptance: real Socket.IO/RPC oracle proves upload intent, storage confirmation, owner ACL,
        AI progress/result and cancellation; `demo/` visibly exercises the same lifecycle using a
        deliberately tiny in-memory HTTP storage adapter.
- [x] 5. AI run protocol (v1.0.78):
  - [x] `Ai.createAiRunHost/client`: provider-neutral run contract with capabilities, owner-scoped
        idempotent `requestId`, durable `runs`/`approvals`/`inputs` Store replay and semantic event replay.
  - [x] runner control: text/tool events, progress/usage, output artifact descriptors, approval and input
        waits, cooperative cancellation plus optional provider abort; late reports/events/results are ignored.
  - [x] acceptance: real Socket.IO/RPC oracle proves ACL, retry after a new connection without duplicate
        provider side effect, approval/input, cancellation and late-output guard; `demo/` visibly runs it.
  - [x] full boundary/operational contract: `doc/AI-RUN-PROTOCOL.md` — provider credentials, storage bytes,
        raw chain-of-thought and browser callbacks are deliberately outside the socket protocol.
- [x] Artifact runtime stand (v1.0.80):
  - [x] `Artifact.createArtifactHost/client`: owner-filtered Store/replay descriptors, private server-side
        storage keys, short-lived authorized open instructions, explicit revoke/expiry and adapter-owned cleanup.
  - [x] `Artifact.createArtifactFrame`: origin-pinned sandboxed iframe (`allow-scripts`, no same-origin or
        parent bridge); the demo serves AI-created HTML from separate `artifact.localhost` with restrictive CSP.
  - [x] acceptance: real Socket.IO/RPC oracle proves ACL, no key/URL in Store, expiry cleanup and iframe
        mounting policy; live demo proves AI run -> descriptor -> isolated interactive counter -> revoke.
- [x] 6. Multi-channel Conversation runtime (v1.0.81):
  - [x] `Conversation.createConversationHost/client`: participant-filtered Store/replay projection,
        account/request-id commands and a trusted server control facade on the existing RPC connection.
  - [x] root/child channel graph, immutable versioned text/list/table/reference/custom blocks, and
        conversation/channel facts with inheritance, isolation, optimistic revisions and tombstones.
  - [x] injected atomic persistence event+receipt boundary plus restart rehydration; real Socket.IO/RPC
        oracle and a two-participant live stand prove branch/fact behavior without touching legacy keys.
- [ ] 7. Authority layer (`predictedStore`, ROADMAP section 3) — only AFTER the demo demands it;
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

No transport work is required for the frontend ↔ storage ↔ AI ↔ Conversation workflow. Next, apply
the injected Resource/Artifact storage ports, AI runner and Conversation persistence port to one real
provider/queue/database adapter. That application bridge should append final assistant blocks and
revisioned facts through `host.control`, while durable archive pagination, tenant quota/audit and the
private artifact-key mapping stay adapter concerns. Add an artifact write-back capability protocol,
`predictedStore`, CRDT, tracks/SFU, or a README GIF only when a consumer establishes that need.
