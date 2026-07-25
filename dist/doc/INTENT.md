# wenay-common2 — project intent

## What this is

A personal, open-source common/transport library, matured over many years. Version `2.x` makes the
second-generation design explicit: JSON-array RPC, Store Replay V2 and the canonical public surface
in `doc/wenay-common2.md` (brief) plus `doc/wenay-common2-rare.md` (full reference).

The current stack is a small distributed-state runtime: a typed RPC core, an `Observe` reactive
store, a universal replay layer (`seq` + keyframe + deltas), a policy-gated route coordinator
(relay ⇄ WebRTC direct), a WebRTC signaling adapter, a media-over-socket layer, and a one-call
`Peer` SDK on top. `StoreReplicaSet` assembles redundant single-authority Store copies from reusable
connection capabilities; `ContractRuntime` binds versioned implementation capabilities without
moving compilation or package delivery into the library. It is oracle-covered (CI on every push)
and shipped with living examples and a runnable demo stand in the repository; the npm package
carries its readable source.

## Intent (2026-07)

- **Open source, not promoted.** The library is public for use and as a portfolio/reference, but the
  author is **not** going to actively market or grow a community around it. Other side-projects are
  the current focus.
- **No pressure to "finish" transport.** The transport/routing/replay lower half is built and good
  enough; ROADMAP transport items are 🧊 deferred (super-low priority, not forbidden). They reopen
  only when a real consumer hits a wall — never speculatively.
- **Value is in being legible and demoable.** The measure of progress is "what can be shown
  working," not layers added. The demo stand and the oracle examples exist to make the design
  readable and hireable, not to chase feature completeness.
- **The library boundary is contract guarantees, not a frontend framework.** UI/framework adapters,
  compilation, application bundles and platform delivery live above this package. The shipped
  contract runtime only owns safe demand/offer selection and implementation lifecycle.
- **Direction if picked up again:** concrete consumer adapters and showcase flows that exercise the
  stable contract/Store/transport layers. Everything else waits for a real need.

This file is the durable record of that intent. It is not a worklist; conditional future work lives
in `doc/ROADMAP.md`, while current engineering guidance lives in `doc/RECOMMENDATIONS.md`.
