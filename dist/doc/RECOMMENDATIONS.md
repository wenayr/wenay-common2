# Recommendations — Listen / Observe / RPC integration

Status refreshed 2026-07-08. This document is now a current checklist, not the
old 2026-07-02 migration scratchpad. Public code should import the canonical
surfaces (`wenay-common2`, `wenay-common2/observe`, `wenay-common2/replay`, or
`src/Common/events/Listen` inside the repo). Numbered implementation artifacts
such as `Listen3` and `reactive2` are compatibility shims only.

## 1. Naming cleanup

- **DONE** `src/Common/events/Listen.ts` is the real implementation file.
  `Listen3.ts` remains only as an internal deep-import shim.
- **DONE** `src/Common/Observe/reactive.ts` is the real reactive implementation.
  `reactive2.ts` remains only as an internal deep-import shim.
- **DONE** the oracle folder is `observe/`, not `observable2/`.
- **RULE** new code and docs should not introduce `UseListen`, `Listen3`,
  `reactive2`, or `observable2` outside `NAMING_RENAMES.md`, historical `doc/changes/` notes, or shim comments.

## 2. Observe store status

- **DONE** circular `Map`/`Set` snapshots are guarded by `seen` before container
  traversal.
- **DONE** `createStoreMirror.sync` reports failed re-pulls through
  `StoreSyncOpts.onError`; initial pull failure still rejects the awaited sync.
- **DONE** path cache identity separates dotted keys and distinct symbols.
- **DONE** brief/rare docs describe the store layer as separate from the coarse
  reactive core.
- **DONE** Dynamic path nodes are pruned after their state disappears and the last
  subscription closes; remote Store writes and replay journaling no longer materialize
  path nodes just to read or write a value.
- **OPEN** `schedule` / `createDrained` in `store.ts` still duplicate scheduler
  logic from `reactive.ts`; extract only if more local schedulers appear.

## 3. Store manager direction

The universal manager should stay above `Observe.createStore` / replay / offline.
It should not make the store core know about products, routes, user habits, or
large-resource policy. The manager owns resource declarations, priority, tags,
usage scoring, explicit-only gates, and start/stop lifecycle.

Current implementation target: `Observe.createStoreManager` with `managedStore`
builders for `mirror`, `replay`, and `offline` resources.

## 4. RPC current over wire

Still open. The client dedup key already includes non-function args, but the
server subscription path does not yet whitelist and forward `{current:true}` to
Listen store decorators. Do not document `{current:true}` over RPC as supported
until server forwarding and late-join replay are implemented together.

## 5. Suggested order

1. Keep naming cleanup green with `rg` before release.
2. Add tests for `createStoreManager` planning, explicit gates, mirror sync, and
   offline/replay startup.
3. Update brief and rare docs only after tests pass.
4. Bump patch version, build, then publish from `dist`.
