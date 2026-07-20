# Recommendations — current seams only

Completed migrations and released work are recorded in `doc/changes/`, not repeated here.

## Scheduler extraction

`schedule` / `createDrained` in `store.ts` still resemble scheduler logic in `reactive.ts`. This is
not a behavior gap. Extract a shared utility only if another scheduler appears or a real bug shows
that the implementations have diverged.

## Conditional features

- Shared documents: integrate a proven CRDT through the engine-neutral provider boundary in
  `doc/ROADMAP.md`; do not make Store itself multi-writer.
- Predicted Store: wait for a consumer that defines command receipt/reject/rebase semantics.
- Media optimization: use the stand's max-video measurements to choose exactly one bottleneck.
