# Keyframe chunking — design sketch, not an approved protocol

Status: **design for discussion**. Nothing here is implemented, and none of it may be implemented
without an explicit public-interface decision. Store Replay V2 is a published wire; changing how a
keyframe crosses it changes a public contract.

Read together with `doc/RECOMMENDATIONS.md` (replay scaling follow-ups, slow-network profile) and
`experiments/slow-network-2026-08/RESULTS.md`, which is the measured evidence behind this page.

## The problem, measured

A Store keyframe is monolithic. `doc/RECOMMENDATIONS.md` records ~3.3 MiB at 100,000 representative
keys, and `experiments/slow-network-2026-08` shows what one such frame does on a constrained link:

- at ~1 Mbit/s an 800 KiB keyframe takes 6.5 s to deliver uncompressed;
- a frame that occupies the link longer than the heartbeat budget starves the queued ping, and the
  client declares `ping timeout`;
- reconnect runs catch-up, catch-up sends the frame again, and the cycle repeats.

Compression and a raised `pingTimeout` each break that cycle today, and both are already recommended.
Neither is a bound: compression ratio depends on the data, and `pingTimeout` must exceed the largest
*legal* frame, which is unbounded as long as one frame carries a whole Store.

Chunking is the structural fix, because it makes the maximum frame size a property of the protocol
rather than of the dataset.

## What must be decided before any code

The canonical architecture page already names the three gates. They are the whole design problem:

1. **Chunk identity** — what a receiver uses to know a chunk belongs to the snapshot it is
   assembling, and to detect a chunk from an abandoned attempt.
2. **Total revision** — what makes the set complete and internally consistent, given that the Store
   keeps changing while the snapshot is being sent.
3. **Atomic apply** — the receiver must never expose a half-applied snapshot, and must not hold two
   full copies of a large Store to achieve that.

## Sketch

### Identity and completeness

A chunked keyframe is one `snapshotId` plus a fixed `total`:

```text
snapshot cursor = (lineId, snapshotId, index, total, seq)
```

- `lineId` already exists and scopes everything to one replay line.
- `snapshotId` is minted by the producer per attempt. A chunk whose `snapshotId` is not the one the
  receiver is assembling is discarded, which is what makes an abandoned attempt harmless.
- `seq` is the journal sequence the snapshot was taken at — the same number `since(seq)` already
  speaks. Every chunk of one snapshot carries the same `seq`, so the tail resumes from exactly one
  point regardless of how many chunks were involved.
- `total` is known when the first chunk is sent, so the receiver can report progress and detect a
  producer that stops mid-set.

The producer does not have to keep the snapshot alive: it must only guarantee that the bytes it
already sent plus the journal tail from `seq` reconstruct the current state. That is the same
guarantee `keyframe()` + `since()` make today.

### Chunk boundaries

Chunks are cut by **byte budget, not key count**, using the existing exact wire-size accounting
(`rpcResultWireMetricsFast`). One top-level value remains indivisible — the same limit
`createStoreReplayView` already documents — so a single value larger than the budget is its own
oversized chunk and must be reported rather than silently split.

The budget is negotiated, not hard-coded: the consumer knows its link, the producer knows its data.
A sane default is well under the heartbeat budget of the slowest supported link.

### Atomic apply without a second full copy

Two candidate strategies, and the choice is the main open question:

| | Buffer-then-commit | Shadow-store apply |
|---|---|---|
| How | receiver accumulates decoded chunks off-Store, commits one root replace at the end | receiver applies each chunk into a hidden store, then swaps the root pointer |
| Peak memory | snapshot + live Store | snapshot + live Store |
| Reuses | the bootstrap path `syncStoreReplayView` already uses | the replaceRoot patch the V2 codec already has |
| Risk | large off-Store accumulation for the whole transfer | hidden store must be invisible to watchers until the swap |

Both keep the invariant that a mirror never shows a partial snapshot. Neither avoids the transient
double memory; avoiding that needs an ownership-transfer decision that
`doc/RECOMMENDATIONS.md` already lists as a separate high-risk route.

### Compatibility

This must be additive or it is not shippable:

- A chunked keyframe is a **capability**, negotiated like the existing `Caps` bits. A peer without
  it receives today's monolithic keyframe and behaves exactly as now.
- `since` / `keyframe` / `frame` keep their current meaning. Chunking is a property of how a
  keyframe is delivered, not a fourth catch-up method.
- V2 patch shapes do not change. A keyframe is still `path: []`; chunking adds an envelope around
  the delivery, not a new patch kind.

### Failure behavior

- A missing or late chunk aborts the attempt: the receiver discards the partial set and restarts
  catch-up from `lastDelivered`, exactly as an evicted tail does today.
- Abort must be cheap and must not resurrect the `gapPolicy: 'error'` distinction — a chunk failure
  is a transport failure, not an eviction, and the two must stay separately observable.
- A producer that stops mid-set is detected by `total`, not by a timeout alone.

## What this sketch does not answer

These are the real decisions, and they belong to a design discussion, not to an implementation pass:

1. Buffer-then-commit versus shadow-store apply.
2. Whether the byte budget is negotiated per line, per consumer, or per call.
3. Whether a chunked keyframe may interleave with live envelopes, or whether the existing
   queue-and-drain behavior covers it unchanged.
4. Whether the producer must pin a snapshot for the duration, or whether "sent bytes + tail from
   seq" is sufficient in every eviction scenario.
5. The exact capability name and its interaction with `frame`, which already exists as the
   compacted one-shot catch-up.

## Gate

Do not implement until 1-5 have explicit answers and the capability shape is agreed. Until then the
shipped mitigations stand: `perMessageDeflate` plus a `pingTimeout` above the largest legal frame,
both measured in `experiments/slow-network-2026-08`.
