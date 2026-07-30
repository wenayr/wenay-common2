# Results — 2026-07-29

## Environment

- Windows `10.0.26200`, x64
- AMD Ryzen AI 7 350, 8 cores / 16 logical CPUs
- Node.js `24.18.0`
- Socket.IO `4.8.3` / `socket.io-client` `4.8.3`, forced to WebSocket, `serveClient: false`
- `ws` `8.21.1` underneath engine.io
- loopback TCP `127.0.0.1`, `perMessageDeflate` disabled
- client and server in one process, as in the July 25 transport stand
- 3 full runs, one fresh Node process per `(family, candidate)` unit, candidate order
  randomized per run and per family from seed `20260729`, warmup discarded in every family
- Workload parameters: 500 small calls with a 3 ms quiet gap · 80 large calls × 1000 records ·
  400 ticks at a target 100/s · 20 flood rounds × 500 ticks · 40 bursts × 50 calls ·
  150 connect cycles
- Payloads: `bar` = `CBar`-shaped `{time: Date, open, high, low, close, volume, tickVolume}`;
  `tick` = `{symbol, seq, time, price, bid, ask, volume, t}`; `quote` = compact request/result

Every cell below is `median [min…max]` over the three runs. Frame and byte counts were
identical in all three runs unless a range is shown.

## Instrumentation, and the check that it is real

Frames were counted at engine.io's `ws` socket (inbound `message`, wrapped `send`); bytes are
the already-serialized lengths. The accepted `net.Socket` byte counters were recorded over the
same window as an independent cross-check. `tcpBytes - wsPayloadBytes` must be exactly the
WebSocket framing overhead — 6 bytes for a masked client frame, 2 or 4 for a server frame
depending on payload size. It is:

| Family | ws payload B/msg | TCP B/msg | difference | expected | frames/msg |
|---|---:|---:|---:|---:|---:|
| `small` | 207.19 | 217.19 | 10.00 | 6 (c2s) + 4 (s2c ≥126 B) | 2 |
| `burst` | 217.27 | 227.27 | 10.00 | 6 + 4 | 2 |
| `flood` `no-callback-batch` | 89.54 | 91.55 | 2.02 | 2 (s2c CBV < 126 B) | 1.004 |
| `flood` `defaults` | 80.79 | 80.87 | 0.08 | 200 frames / 10 000 msgs × ~4 B | 0.02 |

The frame counts are therefore not an estimate; they reconcile with the kernel's own byte
counters to the byte. A unit whose frame probe fails to attach aborts rather than reporting.

## Connect handshake

Per connection, anonymous. `caps-all-off` differs only in the CAPS bitset digit count.

| Candidate | connect→ready p50 | p95 | c2s frames | s2c frames | c2s RPC packets | s2c RPC packets | ws B | TCP B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 2.129 [1.945…2.188] ms | 2.889 ms | 7 | 7 | 5 | 6 | 534.8 | 1099.8 |
| `plain-json` | 2.078 [1.962…2.180] ms | 2.924 ms | 7 | 7 | 5 | 6 | 534.8 | 1099.8 |
| `caps-all-off` | 2.175 [2.166…2.266] ms | 3.294 ms | 7 | 7 | 5 | 6 | 526.8 | 1091.8 |

The packet census per anonymous connection:

| Direction | Packets | Bytes |
|---|---|---:|
| client → server | `CAPS` ×4, `STRICT` ×1 | 52 + 1 |
| server → client | `CAPS` ×4, `MAP` ×2 | 55 + 284 |

With in-band auth (`gate: true`, token presented via `Pkt.HELLO`):

| Candidate | connect→ready p50 | c2s frames | s2c frames | c2s packets | s2c packets | ws B | TCP B |
|---|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 2.295 [2.195…2.374] ms | 8 | 6 | 6 | 5 | 450.8 | 1017.8 |
| `plain-json` | 1.919 [1.894…1.983] ms | 8 | 6 | 6 | 5 | 450.8 | 1017.8 |
| `caps-all-off` | 2.303 [1.954…2.423] ms | 8 | 6 | 6 | 5 | 438.8 | 1005.8 |

Per auth connection: client `CAPS` ×4 (52 B) + `HELLO` ×1 (44 B) + `STRICT` ×1 (1 B); server
`CAPS` ×4 (55 B) + `MAP` ×1 (156 B). A gated server sends a CAPS challenge instead of the
unsolicited MAP, so it sends **one** MAP where the anonymous server sends **two**.

Three of the 14 frames per connection are socket.io's own CONNECT / CONNECT_ACK / DISCONNECT.
The other 11 are RPC control packets. `AUTH_STATE` and `HELLO_ID` change nothing measurable:
turning them off saves 8 bytes per connection (a shorter caps integer) and no frames.

## Family 1 — small request/response, 3 ms quiet gap

Wire is byte-identical for all four candidates: one frame each way per call. Process CPU is
deliberately omitted, exactly as the July stand omitted it for its isolated scenario.

Two per-packet figures appear for this family and they differ by ~4 B: the accounting window
uses sequence numbers above 1 000 000 so its calls cannot collide with the timing window's
0…499, and `seq` appears in both the request and the result. Timing window: `CALL` 56.8 B,
`RESP` 130.4 B. Accounting window: `CALL` 61.0 B, `RESP` 134.6 B. The socket.io envelope is
exactly 10 B per frame in both (`42["rpc",` … `]`), which is how the two reconcile.

| Candidate | p50 | p95 | p99 | c2s frames | s2c frames | c2s B/call | s2c B/call |
|---|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 0.544 [0.529…0.552] ms | 0.844 ms | 1.015 ms | 500 | 500 | 66.78 | 140.41 |
| `no-compact` | 0.555 [0.550…0.560] ms | 0.899 ms | 1.072 ms | 500 | 500 | 66.78 | 140.41 |
| `no-callback-batch` | 0.566 [0.538…0.576] ms | 0.863 ms | 1.026 ms | 500 | 500 | 66.78 | 140.41 |
| `plain-json` | 0.575 [0.556…0.579] ms | 0.884 ms | 1.052 ms | 500 | 500 | 66.78 | 140.41 |

The four candidates are within 0.03 ms of each other with overlapping ranges: **no negotiated
option touches this path.**

For scale against the July stand: its Socket.IO + JSON `isolated-3ms` p50 was 0.449 ms for a
90-byte payload and 0.408 ms for a 304-byte one. This stand carries 187 bytes of RPC JSON per
round trip (207 bytes of WebSocket payload) and measures 0.544 ms. The whole RPC layer — proxy, id pool, route cache,
`pack`/`unpack`, `packResult` — therefore costs on the order of 0.1 ms per round trip here,
and that is an upper bound because the payloads are not identical.

## Family 2 — one call returning 1000 uniform records

Wire is byte-identical for all four candidates. One `RESP` packet of **127 902 B** in **one**
WebSocket frame; the request is 60 B.

| Candidate | p50 | p95 | calls/s | CPU µs/call | loop p95 | GC ms | frames/call |
|---|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 2.609 [2.604…3.491] ms | 4.041 ms | 367.6 | 3900 [2738…3900] | 2.294 ms | 8.94 | 2 |
| `no-compact` | 2.901 [2.726…3.060] ms | 4.172 ms | 349.4 | 3900 [3700…3913] | 2.382 ms | 9.62 | 2 |
| `no-callback-batch` | 3.108 [2.720…3.206] ms | 4.126 ms | 327.0 | 3125 [2550…3525] | 2.390 ms | 9.75 | 2 |
| `plain-json` | 2.997 [2.859…3.169] ms | 4.147 ms | 340.5 | 3525 [2925…3700] | 2.443 ms | 9.75 | 2 |

CPU per call is quantised by the ~15.6 ms Windows accounting granularity even over an 80-call
window; treat 3.1–3.9 ms/call as "about 3–4 ms", not as a ranking.

**Today's negotiated optimizations do nothing at all for a large uniform result.**

## Family 3 — subscription ticks at a target 100/s

All candidates delivered 100.1 [99.9…100.2] ticks/s: the family is rate-limited by design, so
throughput cannot discriminate. Latency is one-way delivery.

| Candidate | p50 | p95 | p99 | s2c frames | s2c RPC packets | packets/frame | s2c B/tick |
|---|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 0.495 [0.460…0.512] ms | 0.737 ms | 0.873 ms | 264 [264…272] | 401 | 1.52 | 89.73 |
| `no-compact` | 0.488 [0.486…0.492] ms | 0.768 ms | 0.903 ms | 264 [258…269] | 401 | 1.52 | 144.73 |
| `no-callback-batch` | 0.415 [0.392…0.446] ms | 0.770 ms | 0.962 ms | 401 | 401 | 1.00 | 90.41 |
| `plain-json` | 0.374 [0.373…0.417] ms | 0.716 ms | 0.871 ms | 401 | 401 | 1.00 | 145.41 |

Two things to read carefully here:

- The batcher merges 1.5 packets per frame at a *nominal* 100/s **only because this host's
  timer granularity is ~15.6 ms**, so the drift-correcting pump emits catch-up pairs. On a host
  with a fine timer and one tick per wake, `CB_BATCH` would merge nothing at this rate. The
  measured 0.5 % byte saving is the honest size of the batching win for a paced stream.
- Compaction is worth 55 bytes per tick (−37.8 %) and costs a little latency: the two
  compaction-off candidates have the two lowest p50s. The gap is 0.04–0.12 ms with p95s that
  overlap, so it is directional, not conclusive — the flood family below settles it.

### First subscription on a fresh connection

Shape state is keyed by `cbId`. The server drops it only on `Pkt.CB_END`, and the client
releases the callback and the id on `RESP` but keeps its shape table. A reused `cbId` therefore
inherits a registered shape, so only the *first* subscription of a connection pays registration:

| Candidate | ticks | s2c frames | s2c packets | s2c B/tick | opcodes |
|---|---:|---:|---:|---:|---|
| `defaults` | 80 | 60 | 85 | 92.6 | `CB`×4 + `SHAPE`×1 + `CBV`×76 |
| `no-callback-batch` | 80 | 85 | 85 | 93.4 | `CB`×4 + `SHAPE`×1 + `CBV`×76 |
| `no-compact` | 80 | 56 | 84 | 144.0 | `CB`×80 |
| `plain-json` | 80 | 84 | 84 | 144.7 | `CB`×80 |

Registration costs 4 full `CB` packets plus one 64-byte `SHAPE`, i.e. about 3.2 bytes per tick
amortised over 80 ticks and nothing at all from the second subscription onward.

## Family 3b — unpaced tick flood

Same subscription path, pacing removed. This is the only family where the batcher can fill a
batch, so it isolates `CB_BATCH` cleanly.

| Candidate | compact | batch | p50 | p95 | ticks/s | CPU µs/tick | loop p95 | s2c frames | packets/frame | s2c B/tick |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | on | on | 2.463 ms | 4.328 ms | 102 382 [96 468…112 534] | 12.5 | 4.321 ms | 180 | 55.7 | 80.71 |
| `no-compact` | off | on | 2.398 ms | 3.966 ms | 111 851 [103 248…112 462] | 11.0 | 3.797 ms | 180 | 55.7 | 135.71 |
| `no-callback-batch` | on | off | 11.104 ms | 14.060 ms | 36 401 [35 826…36 907] | 37.4 | 11.018 ms | 10 020 | 1.00 | 89.46 |
| `plain-json` | off | off | 10.872 ms | 14.823 ms | 38 584 [35 444…40 922] | 32.8 | 10.715 ms | 10 020 | 1.00 | 144.46 |

## Family 4 — burst of 50 parallel calls

| Candidate | p50 | p95 | p99 | calls/s | CPU µs/call | loop p95 | c2s frames | s2c frames | c2s B/call | s2c B/call |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 2.462 ms | 4.445 ms | 5.242 ms | 16 793 [16 458…17 069] | 101.5 | 2.337 ms | 2000 | 2000 | 71.82 | 145.45 |
| `no-compact` | 2.429 ms | 4.272 ms | 5.263 ms | 18 398 [16 254…19 296] | 78.0 | 2.175 ms | 2000 | 2000 | 71.82 | 145.45 |
| `no-callback-batch` | 2.527 ms | 4.456 ms | 5.387 ms | 16 659 [15 836…16 748] | 117.0 | 2.478 ms | 2000 | 2000 | 71.82 | 145.45 |
| `plain-json` | 2.419 ms | 4.199 ms | 5.120 ms | 17 597 [17 509…19 936] | 93.5 | 2.249 ms | 2000 | 2000 | 71.82 | 145.45 |

2000 calls produced exactly 2000 client→server frames and 2000 server→client frames. The
candidate ranges overlap completely and the wire is byte-identical: **nothing negotiable today
touches the burst path.**

## Repeated-key accounting

Deterministic, network-free, and computed on the same `packResult` output that the `large`
family put on the wire. Both representations are encoded and weighed; nothing is estimated.

| Quantity | Value |
|---|---:|
| Packed result, 1000 `CBar` records | 127 896 B |
| Bytes spent on key names and their colons | **63 000 B (49.26 %)** |
| Objects / keys in the result | 2000 / 8000 |
| Same records as `{k: [...keys], r: [[values]…]}` | 70 965 B |
| Saved by row encoding | **56 931 B (44.51 %)** |
| Cost of the `Date` → `{"$_d": …}` wrapper | 8 000 B (8 B per record) |
| Same records with epoch-ms `time`, object form | 119 896 B |
| Same records with epoch-ms `time`, row form | 62 965 B |
| One `tick`, packed | 128 B |
| — of which key names | 55 B (43 %) |
| One `tick` as a values-only array (what `Pkt.CBV` sends) | 73 B |

The analytic tick saving of 55 B is exactly the saving measured on the wire: `CB` averaged
134.5 B per tick and `CBV` 79.5 B. That agreement is the strongest single validation in this
experiment — the byte model and the physical frame counter meet at the same number.

## The four questions

### 1. Where do the frames actually go?

| Family | logical RPC packets | physical frames | packets per frame |
|---|---:|---:|---:|
| `connect` (per connection) | 11 | 14 (3 are socket.io's own) | 0.79 |
| `connect-auth` (per connection) | 11 | 14 | 0.79 |
| `small` (per call) | 2 | 2 | 1.00 |
| `large` (per call) | 2 | 2 | 1.00 |
| `ticks` (400 ticks + call + resp) | 402 | 265 | 1.52 |
| `ticks` with `callbackBatch: false` | 402 | 402 | 1.00 |
| `flood` (10 000 ticks + 20 calls/resps) | 10 040 | 200 | 50.2 |
| `flood` with `callbackBatch: false` | 10 040 | 10 040 | 1.00 |
| `burst` (2000 calls) | 4000 | 4000 | 1.00 |

The answer is blunt. **One direction is batched — server→client callbacks — and only when the
producer is bursty. Everything else is one logical packet per physical frame.** The request /
response path never batches: `small`, `large` and `burst` are all exactly 1.00, and `burst`
proves it under conditions designed to make batching possible (50 calls issued in one
synchronous turn).

The frame is worth about **17–18 µs of combined client+server CPU** on this stand. That falls
straight out of the flood family, where the payload is held constant and only the frame count
changes: 27.5 → 9.8 µs per `CBV` message and 25.9 → 8.9 µs per `CB` message when ~0.98 frames
per message are removed.

### 2. How many bytes go to repeated object keys in family 2?

**63 000 of 127 896 bytes — 49.26 % — measured, not assumed.** Re-encoding the same 1000
records as one key list plus 1000 value rows costs 70 965 B, so the achievable saving is
56 931 B, or **44.5 %**. A further 8 000 B (6.3 %) is the `{"$_d": …}` wrapper the `Date` in
`CBar.time` requires; carrying epoch milliseconds instead would remove it.

### 3. What do `compact` and `callbackBatch` actually buy today?

`compact` (`Caps.COMPACT`, `Pkt.SHAPE` / `Pkt.CBV`) — **a byte win on subscription ticks, paid
for with CPU**:

| Effect | Measurement |
|---|---|
| bytes per tick | 134.5 B → 79.5 B per packet, −40.9 % |
| bytes per tick on the wire | 144.5 → 89.5 B/tick unbatched (−38.1 %); 135.7 → 80.7 B/tick batched (−40.5 %) |
| flood throughput | 111 851 → 102 382 ticks/s, **−8.5 %** |
| flood CPU | 11.0 → 12.5 µs/tick, **+13.6 %** |
| flood throughput, unbatched | 38 584 → 36 401 ticks/s, −5.7 %; CPU 32.8 → 37.4 µs, +14.0 % |
| paced ticks latency | p50 0.374 → 0.415 ms unbatched, 0.488 → 0.495 ms batched (directional, ranges overlap) |
| registration cost, first subscription only | 4 full `CB` + one 64 B `SHAPE`, ~3.2 B/tick over 80 ticks |
| `small`, `large`, `burst` | **zero** — byte-identical wire |

`callbackBatch` (`Caps.CB_BATCH`, `Pkt.CB_BATCH`) — **the largest single lever measured here,
and only on bursty callback emission**:

| Effect | Measurement |
|---|---|
| flood frames | 10 020 → 180, **55.7 logical packets per frame** |
| flood throughput | 36 401 → 102 382 ticks/s (**2.81×**) with compaction on; 38 584 → 111 851 (**2.90×**) with it off |
| flood p50 | 11.104 → 2.463 ms (**4.5×** lower) |
| flood CPU | 37.4 → 12.5 µs/tick, **−66.6 %** |
| flood event-loop delay p95 | 11.018 → 4.321 ms |
| flood bytes | 89.5 → 80.7 B/tick, −9.8 % (frame envelope amortised) |
| paced 100/s ticks | frames 401 → 264, bytes −0.5 %, throughput unchanged, latency unchanged — and even that much only because this host's coarse timer forces catch-up pairs |
| `small`, `large`, `burst` | **zero** — byte-identical wire |

### 4. Which of the three candidate optimizations does the data support?

**First: batch client→server `CALL` and server→client `RESP`.**

The evidence is direct. `burst` is 1.00 packets per frame in both directions under exactly the
conditions batching exists for; a frame costs 17–18 µs; and the flood family already
demonstrates, on this stand, with the payload held constant, that collapsing N packets into one
frame is worth 2.8–2.9× throughput and −67 % CPU per message.

Expected size, derived from measured per-packet sizes (`CALL` 61.8 B, `RESP` 135.5 B,
socket.io envelope 10 B per frame) for one burst of 50:

| | today | one batch frame per direction | change |
|---|---:|---:|---:|
| frames | 100 | 2 | −98 % |
| client→server bytes | 3 591 B | 3 156 B | −12.1 % |
| server→client bytes | 7 273 B | 6 838 B | −6.0 % |
| CPU per call (model) | 59.5 µs | ~25 µs | ~2.4× throughput |

The CPU line is a *model*: measured cost per call minus the measured cost of 49/50 of two
frames. It ignores the extra cost of serializing one large frame and the batcher's own
bookkeeping, so treat 2.4× as an optimistic bound and 2× as the number to design against.

The limits are equally clear from the data. `small` — one call at a time — has nothing to
batch and would gain exactly nothing; batching there can only add a microtask of latency. The
win exists only where calls are genuinely concurrent, which is what family 4 models.

**Second: a connection-scoped shape registry with table/row encoding for arrays and `RESP`
results.**

Supported as a *bandwidth* optimization, and the size is known precisely: 49.26 % of a
1000-record result is key names, and row encoding removes 44.51 % of the packet. The mechanism
is already proven in miniature — `Pkt.CBV` does exactly this for one object and its analytic
and measured savings agree to the byte.

But it is second, not first, and this stand says why: family 2 already uses **one frame per
direction**, so there is no frame to remove, and on loopback the byte saving buys nothing
measurable — all four candidates sit at 2.6–3.1 ms p50 with overlapping ranges. Worse, the
compaction machinery is not free: the same mechanism costs +14 % CPU per message in the flood
family. On a loopback stand this optimization is a net loss; on a metered or congested link it
is a 44 % bandwidth cut. **It must be judged on a real route, not here**, and it should be
implemented so the encoding can be declined when the link is cheap.

**Third: folding the connect handshake round trips. The data does not support this as a
performance change.**

A connection costs 11 RPC control packets in 14 frames, 535 B of WebSocket payload against
1 100 B of TCP — the HTTP upgrade is twice the RPC handshake. At 17.5 µs per frame the entire
RPC handshake is roughly 0.2 ms of CPU against a measured 2.1 ms connect-to-ready. Removing
all of it would be a ~10 % improvement on an operation that happens once per connection.

There is one clearly wasteful item worth fixing as hygiene rather than as an optimization: an
anonymous server sends `Pkt.MAP` **twice** — unsolicited at construction, and again in answer
to the client's `Pkt.STRICT`. That is 142 B and one frame per connection with no observable
purpose. A gated server sends one, because its unsolicited packet is a CAPS challenge instead.
Likewise the four `CAPS` packets per direction are more than the negotiation needs.

What this stand **cannot** decide is the part that would actually justify the work: how many of
those 11 packets are *sequentially dependent* round trips. Loopback RTT is near zero, so a
serialized exchange and a pipelined one look the same. The packet census plus the code path
(`socket.on(key, …)` then `sendCapsChallenge()` or `sendMap()` in `rpc-server.ts`) indicates
that an anonymous connection needs no RPC round trip at all — `ready()` can settle on the
unsolicited MAP — while in-band auth needs exactly one (HELLO → MAP). If that is right, there
are no round trips to fold for the anonymous case and exactly one, inherent, for the auth case.
Confirming it needs a delayed or real route and an ordered, timestamped packet trace. Until
then this is an inference from the census, not a measurement, and it is the reason this
candidate ranks third.

## Negative and null results, stated plainly

- `compact` and `callbackBatch` have **exactly zero** effect on `small`, `large` and `burst`.
  Not "small", not "within noise" — byte-identical wire and identical frame counts. Anyone
  hoping the existing options already help request/response traffic should stop hoping.
- `callbackBatch` buys essentially nothing for a *paced* 100/s subscription. The 0.5 % byte
  saving observed here is an artifact of this host's ~15.6 ms timer forcing catch-up pairs; on
  a host with a fine timer it would be 0 %. Its value is entirely in bursty emission.
- `compact` is a **net loss on loopback**: −6 to −8.5 % throughput and +14 % CPU per message,
  in exchange for bytes that loopback does not charge for. That is the correct trade for a real
  link and the wrong one for an in-process or LAN-local deployment; it is negotiable per
  connection today, which is the right design.
- `AUTH_STATE` and `HELLO_ID` are negotiable but not measurable: turning both off changed the
  wire by 8 bytes per connection (a shorter caps integer) and no frames.
- Row/table encoding, the single largest byte win available (−44.5 %), produced **no measurable
  time win** in family 2 on this stand. That is a real negative result for a loopback
  deployment, not a reason to drop the idea.

## Anomalies and measurements that could not be made trustworthy

**A first full 3-run pass was discarded as contaminated and is kept for the record.** During
that pass the log was polled from another process while units ran. Run 1 of that pass is
visibly corrupted: `small` units took 15–35 s instead of the 8.2 s they take undisturbed, p95
latencies reached 13 ms against a 0.9 ms median, and event-loop delay p95 reached 85 ms. Runs 2
and 3 of that pass match the clean pass reported above. Direction and ratios of every
conclusion above were the same in both passes; only the spreads differ. Two conclusions moved
in magnitude between passes and should be read with that in mind:

| Claim | contaminated pass | clean pass |
|---|---:|---:|
| `compact` cost, flood throughput | −25.5 % | −8.5 % |
| `CB_BATCH` gain, flood throughput | 2.48× / 2.92× | 2.81× / 2.90× |

This stand is sensitive to background load at the tens-of-microseconds scale it measures.
Anyone re-running it should leave the machine alone.

**CPU per message for the paced `ticks` family is not trustworthy and is not used above.**
Across three runs the medians were 117.5, 235, 587.5 and 390 µs/tick for candidates whose wire
differs by at most 38 %, with per-run ranges as wide as `[77.5…1797.5]`. Windows CPU accounting
over a 4 s window punctuated by ~100 short sleeps produces quantised garbage. This is the same
failure the July experiment anticipated when it refused to report CPU for its isolated
scenario; the flood and burst families, which have no sleeps, give stable CPU numbers and are
used instead.

**Event-loop delay has a ~15.6 ms floor on this host.** `small` and `ticks` report a loop p95
of almost exactly 16.0 ms in every candidate and every run — that is the timer granularity, not
the RPC layer. Only the busy families (`flood` 3.8–11.0 ms, `burst` 2.2–2.5 ms) produce a
figure that discriminates, and there it does: batching halves the flood event-loop delay.

**CPU per call in family 2 is quantised.** 80 calls over ~230 ms give CPU deltas in 15.6 ms
steps, so the 3125–3900 µs/call figures should be read as "about 3–4 ms" and never ranked.

**The number of sequentially dependent handshake round trips could not be measured.** See
question 4, third candidate.

## Seams missing from `src/` (reported, not added)

Nothing in `src/` was changed for this experiment, and everything needed was reachable from
outside. Three things made it harder than it should be:

1. **No packet-observation seam on either facade.** The only way to see RPC packets is to wrap
   the `{emit, on}` adapter before handing it to `createRpcServer` / `createRpcClient`. That
   works for *sent* packets, but a wrapper cannot distinguish a packet a guard suppressed from
   one that was never produced, and observing *received* packets means wrapping every `on`
   callback and re-implementing the opcode switch. An optional
   `hooks.onPacket?: (direction, packet) => void` on both facades — or a counter facet on the
   server's `control` — would make this a supported measurement instead of a wrapper trick.

2. **The negotiated capability set is not readable.** `serverCaps & peerCaps` is private on both
   sides. This bench had to *infer* that compaction was active by observing `Pkt.CBV` on the
   wire, and that batching was active by observing `Pkt.CB_BATCH`. A read-only accessor (a
   `caps()` on the client handle and on `RpcServerControl`) would let a test assert what was
   negotiated rather than deduce it, and would have caught a mis-specified candidate instantly.

3. **Shape-registry lifetime is invisible and unbounded by the caller.** Measured, not assumed:
   the server drops `cbShapes` state only on `Pkt.CB_END`, and the client (`rpc-client.ts`, the
   `Pkt.RESP` case) deletes the callback and releases the id but leaves `compactShapes[cbId]` in
   place. A later call that reuses that `cbId` therefore inherits a registered shape — the
   second and every later subscription on a connection sends no `Pkt.SHAPE` and no full-`CB`
   warmup, which is exactly what the cold-subscription table shows. This is not a correctness
   bug: shapes are matched by key signature, so a different shape simply registers a new id.
   But it is per-connection state with no accessor, no eviction seam and no way for a test to
   observe it, and any future connection-scoped shape registry will inherit the same problem at
   a larger scale. It deserves an explicit lifetime before it grows.

## What the next experiment should do

1. Re-run the `large` family over a delayed or real route. This stand can prove the 44.5 % byte
   saving and cannot value it.
2. Trace handshake packets in order with timestamps, over a route with real RTT, to count
   sequentially dependent round trips rather than packets.
3. Prototype `CALL` / `RESP` batching behind a new capability bit and re-run families 1 and 4
   unchanged. Family 1 is the regression guard — it must not get slower.
4. Add a concurrency axis. Every family here uses one connection; per-frame cost and batching
   value both change once many sockets share one event loop.
5. Re-run the tick families on a host with a fine timer, so the paced 100/s result is not
   confounded by 15.6 ms granularity.
6. Measure with `perMessageDeflate` on. Repeated JSON keys are exactly what a deflate context
   removes, so the 49.26 % key share measured here is an upper bound on what a table encoding
   can be worth on a compressed link.

---

# Results — 2026-07-29, second pass: `Caps.REQ_BATCH` (`opt.requestBatch`)

This pass answers follow-up **1** of the list above ("prototype `CALL`/`RESP` batching behind a new
capability bit and re-run families 1 and 4 unchanged"). The bit is now implemented in `src/`, so this
is no longer a model: `request-batch` is a real candidate on the same stand, and `defaults` is its
own control — the two differ by exactly one bit and nothing else.

Same host, same Node, same socket.io, same seed `20260729`, same 3 runs / fresh process per unit /
randomized candidate order. One row was added to `DATA_CANDIDATES`, so the matrix is 31 units per run
instead of 26. The meter unpacks `Pkt.BATCH` exactly as it already unpacked `Pkt.CB_BATCH`, so the
"logical packets" column keeps its meaning.

`request-batch` is `{requestBatch: true}` — everything else default. The bit is **off by default**,
which is why `defaults` is a valid control.

**Two independent 3-run passes were taken.** The first is kept only as a cross-check because one
PowerShell process was started on the host while it ran; the numbers below are from the second,
undisturbed pass. Where the two disagree it is said so explicitly.

## Family 4 — burst of 50 parallel calls (the family this bit exists for)

40 bursts × 50 calls = 2000 calls. `median [min…max]` over 3 runs.

| Candidate | p50 | p95 | p99 | calls/s | CPU µs/call | loop p95 | c2s frames | s2c frames | c2s B/call | s2c B/call |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 2.221 [1.856…2.387] ms | 3.975 ms | 4.921 ms | 21 020 [17 616…21 704] | 85.5 [55…85.5] | 1.986 ms | 2000 | 2000 | 71.82 | 145.45 |
| **`request-batch`** | **0.855 [0.820…0.997] ms** | **1.528 ms** | **2.023 ms** | **47 626 [38 770…48 887]** | **23.5 [23…39]** | **1.501 ms** | **40** | **40** | **63.14** | **136.77** |
| `no-compact` | 2.257 ms | 4.514 ms | 5.708 ms | 19 404 [9 322…19 923] | 77.5 | 2.304 ms | 2000 | 2000 | 71.82 | 145.45 |
| `no-callback-batch` | 1.985 ms | 3.619 ms | 4.521 ms | 20 476 [18 525…22 856] | 85.5 | 2.038 ms | 2000 | 2000 | 71.82 | 145.45 |
| `plain-json` | 1.960 ms | 3.483 ms | 3.766 ms | 21 898 [12 543…22 709] | 86.0 | 1.874 ms | 2000 | 2000 | 71.82 | 145.45 |

Frames are exact and identical in all three runs: **2000 → 40 in each direction**, i.e. one burst of
50 calls costs **2 physical frames instead of 100** (−98 %). The accounting window agrees: 8 frames
for 8 bursts each way against 400.

Against the model in question 4 of the first pass:

| Quantity | modeled | measured | |
|---|---:|---:|---|
| frames per 50-call burst | 100 → 2 | 100 → 2 | exact |
| client → server bytes | −12.1 % | 71.82 → 63.14 B/call = **−12.09 %** | exact |
| server → client bytes | −6.0 % | 145.45 → 136.77 B/call = **−5.97 %** | exact |
| throughput | ~2.4 × optimistic bound, **2 × to design against** | **2.27 ×** | between the two |
| CPU per call | 59.5 → ~25 µs (model) | 85.5 → 23.5 µs, **−72.5 %** | better than modeled |

The second pass and the discarded first pass agree on the headline to two significant figures:
**2.27 ×** here, **2.28 ×** there (47 378 / 20 759). p50 falls 2.60 ×, p95 falls 2.60 ×, event-loop
delay p95 falls 1.986 → 1.501 ms.

**The win landed above the number this was designed against and just under the optimistic bound.**
Nothing here is disappointing; the one number that moved the wrong way is in the flood family below
and is shown to be noise.

## Family 1 — small request/response, 3 ms quiet gap (the regression guard)

This is the family that had to *not* get slower. It has one call in flight at a time, so the batcher
never has a second packet to merge and every batch is a one-item batch, which is sent unwrapped.

| Candidate | p50 | p95 | p99 | c2s frames | s2c frames | c2s B/call | s2c B/call |
|---|---:|---:|---:|---:|---:|---:|---:|
| `defaults` | 0.458 [0.429…0.581] ms | 0.788 [0.732…0.965] ms | 0.894 ms | 500 | 500 | 66.78 | 140.41 |
| `request-batch` | 0.441 [0.404…0.584] ms | 0.775 [0.753…0.917] ms | 0.915 ms | 500 | 500 | 66.78 | 140.41 |
| `no-compact` | 0.442 ms | 0.760 ms | 0.925 ms | 500 | 500 | 66.78 | 140.41 |
| `no-callback-batch` | 0.497 ms | 0.785 ms | 1.001 ms | 500 | 500 | 66.78 | 140.41 |
| `plain-json` | 0.445 ms | 0.807 ms | 1.121 ms | 500 | 500 | 66.78 | 140.41 |

**The wire is byte-identical to the other four candidates** — 500 frames each way, same bytes per
call. A one-item batch is not wrapped, so turning the bit on changes nothing observable here.

Latency is unchanged and the direction of the tiny difference is not stable:

| Pass | `defaults` p50 | `request-batch` p50 | Δ |
|---|---:|---:|---:|
| clean (reported) | 0.458 ms | 0.441 ms | −0.017 ms |
| cross-check | 0.428 ms | 0.446 ms | +0.018 ms |

The sign flips between passes and the `[min…max]` ranges overlap almost completely
(`[0.429…0.581]` vs `[0.404…0.584]`). **No latency regression on the isolated case**, which is the
condition this optimization had to meet.

## Families 2, 3, 3b — everything the bit was not aimed at

| Family | Candidate | key figures | verdict |
|---|---|---|---|
| `large` (1000 records) | `defaults` | p50 2.810 [2.139…3.903] ms · 349 calls/s · 80 frames each way · 127 912 B | |
| `large` | `request-batch` | p50 2.532 [2.234…2.769] ms · 376 calls/s · 80 frames each way · 127 912 B | wire identical, no regression |
| `ticks` (paced 100/s) | `defaults` | p50 0.383 ms · 264 [263…266] s2c frames · 89.72 B/tick | |
| `ticks` | `request-batch` | p50 0.443 ms · 263 [261…267] s2c frames · 89.72 B/tick | same framing, same bytes |
| `flood` (unpaced) | `defaults` | 119 272 [118 202…123 093] ticks/s · 180 frames · 80.71 B/tick · CPU 9.4 µs | |
| `flood` | `request-batch` | 119 724 [84 318…132 670] ticks/s · 180 frames · 80.71 B/tick · CPU 14.1 µs | same framing and bytes; CPU — see below |

`large` is the interesting one. A 128 KB `RESP` is a batchable packet, and the naive batcher would
have sized it with `JSON.stringify` on every call to discover that it exceeds the byte ceiling and
has to go alone. It does not: the batcher inspects a packet only once a second one turns up to share
its frame, and a lone packet leaves unwrapped either way. Measured cost of that decision: **none** —
`request-batch` is if anything faster than `defaults` here, with overlapping ranges and an identical
127 912 B single-frame result.

`ticks` and `flood` change envelope (`Pkt.BATCH` instead of `Pkt.CB_BATCH`) and nothing else: same
180 frames for 10 000 ticks, same 80.71 B/tick, same throughput within spread.

## The one number that moved the wrong way, and why it is noise

`flood` CPU per tick reads 9.4 µs for `defaults` and 14.1 µs for `request-batch` in the clean pass,
with ranges that do not overlap (`[7.7…10.8]` vs `[11…20.3]`). Taken alone that would be a +50 % CPU
cost for an envelope that produces a byte-identical wire.

It is not real. **The cross-check pass has the same two numbers reversed:**

| Pass | `flood` CPU, `defaults` | `flood` CPU, `request-batch` |
|---|---:|---:|
| clean (reported) | 9.4 [7.7…10.8] µs | 14.1 [11…20.3] µs |
| cross-check | 15.6 [10.9…15.6] µs | 7.9 [7.8…12.5] µs |
| first experiment (July, no such candidate) | 12.5 µs | — |

`defaults` alone spans 9.4 / 12.5 / 15.6 µs across three passes of the *same* build and *same*
candidate. The pass-to-pass drift of this figure is larger than the difference being claimed, and
flood throughput — the number that would have to move with it — is identical (119 272 vs 119 724,
overlapping ranges). There is no measurable flood CPU effect.

## What this pass does and does not license

- It licenses **`opt.requestBatch` for workloads that issue concurrent calls**: 2.27 × throughput,
  −72 % CPU per call, −12 % / −6 % bytes, 100 frames → 2 per burst, all reproduced across two passes.
- It licenses **leaving the bit off by default**. Family 1 gains exactly nothing — byte-identical
  wire, unchanged latency — so a library-wide default would be a change nobody asked for on the
  latency-critical path. `defaults` being a valid control in this table is a direct consequence.
- It does **not** license any latency claim for a real route: this is loopback, and the frames it
  removes cost 17–18 µs of local CPU rather than a round trip. On a real link the byte saving
  (−12 % / −6 %) and the removed frames are worth *more*, not less, but that has to be measured
  there.
- It does **not** speak about many concurrent connections. Everything here is one socket, and the
  per-session queue is exactly where fan-out would change the answer.
- It says nothing new about `compact`, `AUTH_STATE` or `HELLO_ID`; those rows repeat the first pass.

## Follow-ups still open

Items 2, 4, 5 and 6 of the first pass's list are untouched. Item 1 (the `large` family over a real
route) is now more interesting, not less: `request-batch` demonstrates that removing frames is worth
2.27 × on a stand where a frame costs only CPU, which sharpens rather than answers the question of
what a 44.5 % byte saving is worth on a metered link. Item 3 of that list is discharged by this pass.

---

# Results — 2026-07-29, third pass: `Caps.ROWS` (`opt.compactRows`)

This pass answers follow-up **2** of the first pass's list — "a connection-scoped shape registry with
table/row encoding for arrays and `RESP` results" — which that pass ranked second and licensed only
as a *bandwidth* optimization, with the explicit warning that "on a loopback stand this optimization
is a net loss" because the `large` family already uses one frame per direction and the same
compaction machinery costs +14 % CPU in `flood`.

**That warning turned out to be wrong, and the reason is worth stating before the numbers.** The
+14 % CPU of `compact` is what it costs to *add* structure to a tick — build a shape, look it up,
map values. Row encoding removes ~57 KB of repeated key names from a 128 KB payload *before*
`JSON.stringify` ever sees them, and that saving is larger than the scan that finds it. It is not
the same trade in a different place; it is the opposite trade.

Same host, same Node, same socket.io, same seed `20260729`, same 3 runs / fresh process per unit /
randomized candidate order. `DATA_CANDIDATES` is 6 wide, so the matrix is 36 units per run.

The bit shipped **ON**, so unlike `request-batch` its control is an explicit opt-out:
**`no-row-compact` = `{compactRows: false}` vs `defaults` is that bit OFF vs ON and nothing else.**
`no-compact` and `plain-json` disable `Caps.COMPACT`, which `Caps.ROWS` requires, so they read as
rows-off too; `request-batch` and `no-callback-batch` keep rows on.

## Family 2 — one call returning 1000 uniform records (the family this bit exists for)

80 calls × 1000 `CBar`-shaped records. `median [min…max]` over 3 runs. Rows-on candidates in bold.

| Candidate | rows | p50 | p95 | calls/s | CPU µs/call | loop p95 | GC ms | s2c B/call |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **`defaults`** | **on** | **2.390 [1.894…2.479] ms** | **3.461 [3.217…3.624] ms** | **412.0 [397.3…478.2]** | 3125 [2350…3312.5] | 2.249 ms | 7.708 | **70 983** |
| `no-row-compact` | off | 3.144 [2.698…3.266] ms | 4.054 [3.702…4.293] ms | 326.7 [305.6…367.7] | 3112.5 [2937.5…3712.5] | 2.396 ms | 9.033 | 127 912 |
| **`no-callback-batch`** | **on** | 2.349 [2.159…2.521] ms | 3.249 [3.233…3.891] ms | 400.5 [370.7…418.3] | 2537.5 [2337.5…3137.5] | 2.238 ms | 7.694 | **70 983** |
| **`request-batch`** | **on** | 2.438 [2.366…2.525] ms | 3.581 [3.342…9.315] ms | 372.0 [285.3…407.4] | 3512.5 [3337.5…3712.5] | 2.150 ms | 8.170 | **70 983** |
| `plain-json` | off | 3.161 [3.157…3.322] ms | 4.172 [4.170…4.275] ms | 316.0 [294.4…335.3] | 3525 [3300…3712.5] | 2.374 ms | 9.275 | 127 912 |
| `no-compact` | off | 3.369 [2.425…3.378] ms | 4.035 [3.739…4.321] ms | 298.7 [295.0…384.6] | 3512.5 [2937.5…3912.5] | 2.423 ms | 9.350 | 127 912 |

The three rows-on candidates land together and the three rows-off candidates land together, which is
the shape a real effect has and noise does not.

| Quantity | off | on | change |
|---|---:|---:|---|
| WebSocket payload per call | 127 912 B | **70 983 B** | **−56 929 B, −44.51 %** |
| the `RESP` packet itself | 127 902 B | 70 973 B | −44.51 % |
| frames per call | 2 | 2 | unchanged — there was never a frame to save |
| p50 | 3.144 ms | **2.390 ms** | **−24.0 %**, ranges do not overlap |
| p95 | 4.054 ms | 3.461 ms | −14.6 % |
| throughput | 326.7 calls/s | **412.0 calls/s** | **+26.1 %**, ranges do not overlap |
| CPU per call | 3112.5 µs | 3125 µs | **unchanged** (see below) |
| GC | 9.033 ms | 7.708 ms | −14.7 % |
| event-loop delay p95 | 2.396 ms | 2.249 ms | −6.1 % |

**The byte figure is exact and matches the analytic model to 18 bytes.** The repeated-key accounting
in the first pass predicted 70 965 B for a row encoding of these records; the wire carries 70 983 B,
the difference being the `RESP` envelope and the shape id. Frame counts and byte counts were
identical in all three runs.

**CPU per call must be read as "unchanged", not as a win.** The first pass established that this
figure is quantised in 15.6 ms steps over an 80-call window and told the reader never to rank it,
and this pass obeys that: 3112.5 vs 3125 µs with ranges that overlap almost completely. An earlier
pass of an earlier revision of the same encoding measured 3112.5 → 2150 µs, i.e. a −31 % CPU win,
with non-overlapping ranges — and that pass-to-pass drift is larger than the difference it claimed.
The trustworthy statements are the ones that do not depend on Windows CPU accounting: **bytes are
exact, and p50 and throughput moved by ~25 % with non-overlapping ranges.**

The honest headline is therefore: **−44.5 % bytes for no CPU cost**, and, unusually for this
family of optimization, a wall-clock improvement on a stand that charges nothing for bytes.

## Families 1, 3, 3b, 4 — everything the bit was not aimed at

Every one of them is **byte-identical** with the bit on and off. That is the point: a payload with
no array of uniform records has nothing to encode, and the encoder says so without changing a byte.

| Family | `defaults` (rows on) | `no-row-compact` (rows off) | verdict |
|---|---|---|---|
| `small` | p50 0.547 [0.522…0.565] ms · 140.41 B/call · 500 frames | p50 0.522 [0.503…0.540] ms · 140.41 B/call · 500 frames | wire identical; see below |
| `ticks` | p50 0.457 [0.428…0.462] ms · 89.71 B/tick · 53 frames/80 | p50 0.426 [0.403…0.470] ms · 89.72 B/tick · 53 frames/80 | identical framing and opcodes |
| `flood` | 90 863 [89 303…113 121] ticks/s · 12.5–18.7 µs · 80.712 B/tick | 90 466 [89 493…111 154] ticks/s · 12.5–23.5 µs · 80.712 B/tick | byte-identical, ranges overlap |
| `burst` | p50 2.692 ms · 16 146 calls/s · 145.451 B/call | p50 2.671 ms · 15 963 calls/s · 145.451 B/call | byte-identical, ranges overlap |

**`small` is the regression guard and it passes on the strongest possible evidence: the wire is
byte-identical.** The 0.025 ms between the two is inside the noise band the family shows anyway —
all six candidates, whose wires are the same 140.41 B/call and 500 frames each way, spread across
0.504–0.547 ms p50 in this pass. A timing difference between candidates that cannot differ on the
wire is a measurement of the host, not of the option.

### What the connection-scoped registry did to the tick families: nothing, and that is correct

The registry replaces a per-`cbId` shape table with one per-connection table, so the obvious question
is whether the tick wire moved. It did not, and the accounting pass shows it opcode by opcode:

| Candidate | cold subscription, 80 ticks | s2c B/tick |
|---|---|---:|
| `defaults` (rows on) | `CAPS×3` + `CB×4` + `SHAPE×1/64B` + `CBV×76` | 92.6 |
| `no-row-compact` (rows off) | `CAPS×3` + `CB×4` + `SHAPE×1/64B` + `CBV×76` | 92.6 |

Identical, including the four full `CB` packets before the shape earns its id. The reason is that
these families run **one** subscription: a connection-scoped registry can only pay when a shape is
shared between two producers, and there is no second producer here. The stand has no family that
mixes a large response and a subscription of the same record shape, which is exactly where the
sharing is worth something — `rpc.harness.spec.ts` Stage 9 covers that case as behaviour (a tick
after a table skips the five-repeat threshold and registers immediately) and this stand does not
price it. **Reported as a gap, not as a result.**

## Anomalies

**One 3-run pass was discarded as contaminated.** It was started in the same command line as
`npm run test:rpc`, and although cmd runs the two sequentially the pass came out visibly noisy:
`defaults` alone spanned 246.4…444.4 calls/s in family `large` (a 1.8× spread within one candidate,
against 397.3…478.2 in the clean pass), and the candidate ordering was inconsistent with both the
clean pass and the wire. Its byte columns agree with the clean pass exactly, which is the expected
behaviour of an exact measurement under a noisy clock. The reported pass was run alone.

**The `ticks` CPU column is again untrustworthy** and is not used: this pass produced medians of
0, 40, 115, 235, 235 and 310 µs/tick for candidates whose wire differs by at most 38 %, with a `0`
median where the accounting window happened to fall inside one 15.6 ms tick. Same failure the first
pass documented.

## What this pass does and does not license

- It licenses **`opt.compactRows` ON by default**. It is the first negotiated option measured here
  that costs nothing on the path it does not touch (byte-identical wire in four of five families)
  and improves the one it does on *both* axes. The condition that would have argued for off —
  a CPU regression outweighing the bytes on a loopback route — did not occur.
- It licenses the claim that **row encoding is not the `compact` trade**. `compact` buys 41 % of a
  tick for +14 % CPU; rows buy 44.5 % of a large result for no measurable CPU, because the bytes it
  removes are bytes `JSON.stringify` would otherwise have had to produce.
- It does **not** license a latency claim for a real route, in either direction. Loopback charges
  nothing for the 56 929 bytes removed, so the −24 % p50 measured here is the value of *not
  serializing* them, not the value of not sending them. On a metered or congested link the saving
  is worth more, and that still has to be measured there — follow-up 1 of the first pass is open.
- It does **not** speak about compression. `perMessageDeflate` is off, and repeated keys are exactly
  what a deflate context removes; on a compressed link this saving shrinks by an unmeasured amount.
  This is follow-up 6 and it is now the most interesting one for this bit.
- It says **nothing about the sharing half of the registry**, which no family exercises. See above.
- It does not speak about many concurrent connections. The registry is per server instance with
  per-session declaration tracking, and fan-out is exactly where a shared table's cost would show.

## Follow-ups still open

Items 2, 4, 5 and 6 of the first pass's list are untouched; item 1 (a real route) is now the
gating question for this bit, and item 6 (deflate on) is its natural companion. Two new ones:

7. Add a family that mixes a large uniform response with a subscription of the **same record
   shape**, so the connection-scoped registry has something to share and the sharing can be priced.
8. Re-run `large` with a record shape whose values are large relative to its keys (long strings,
   nested objects). The 49.26 % key share is a property of `CBar`, and the whole saving scales with
   it; a payload with a low key/value ratio should show the encoding earning much less.

## The one item this pass deliberately did not fix

The first pass reported that an anonymous server sends `Pkt.MAP` **twice** per connection — the
unsolicited push and the answer to the client's `Pkt.STRICT` — for 142 B and a frame. The wire
structure table above still shows `MAP×60` for 30 connections. Both available fixes were implemented
and both were reverted against the harness:

- **Dropping the push** (challenge only, as a gated server does) breaks every client that never
  calls `ready()`: three harness checks fail because the schema, and with it the declared Listen
  paths, never arrive. Making the client ask for the schema from its `Pkt.CAPS` handler instead
  fixes those three and breaks four in-band auth checks, because the extra `Pkt.STRICT`/`Pkt.HELLO`
  interleaves with the provider handshake.
- **Suppressing the STRICT answer** is not decidable on the server. `Pkt.STRICT` carries no evidence
  of what the peer already holds, and the server cannot distinguish "the push was delivered and the
  STRICT merely raced it" from "the push was emitted before the peer attached and was lost".
  The second case is real in this repo — `createInProcSocketPair` resolves listeners at emit time,
  so a server built before its client loses the push — and suppressing there hangs the client.

Removing the duplicate needs the client to say what schema it already has, which is a wire change
and therefore a capability bit, not the hygiene it was filed as. Recorded in `rpc-server.ts` at the
call site so the next reader does not re-derive it.

# Fourth pass — the second `Pkt.MAP` of a connection, and why it is still there

This pass has no new bit and no new numbers for the data families. It exists because the item the
previous two passes deferred — "an anonymous server sends `Pkt.MAP` twice per connection, 142 B and
a frame" — turns out to have been described wrongly, and the correction changes what any future
attempt has to do. Nothing under `src/` ships from this pass; the tree is byte-identical on the wire
to the third pass, re-measured below.

## The correction: the two MAPs are not a duplicated answer

The first pass recorded `MAP ×2` per anonymous connection and assumed one of them was redundant.
It is not, in the way that phrasing suggests. **On this stand the FIRST one — the unsolicited push
emitted inside `createRpcServer` — reaches nobody at all.**

`connectStandClient` (and any consumer written the same way) does:

```ts
await new Promise(resolve => socket.once('connect', resolve))
const client = createRpcClient({...})
```

engine.io hands `CONNECT_ACK`, the server's caps challenge and the server's `Pkt.MAP` to the
namespace inside **one synchronous `ws` read**. `resolve` only queues a microtask, so the RPC
client — and with it the `socket.on('rpc', …)` listener — does not exist yet when the second and
third packets are dispatched, and socket.io drops an event with no listener. Verified directly with
a packet probe on the real stand transport:

| Probe | c2s `CALL` route | Meaning |
|---|---|---|
| anonymous connect, `init()` called | numeric (`0`) | schema came from the answer to `Pkt.STRICT` |
| anonymous connect, `init()` **not** called | `["add"]` | **no schema ever arrived** — the push was lost |

The second row is the load-bearing one: today, a direct socket.io client that never calls `ready()`
gets no schema at all, and its calls travel by path. The push that exists precisely for that client
is the packet that goes into the void, and the `Pkt.STRICT` answer is the only MAP that works.

Where the peer *is* attached first — `createRpcInProc` (server built before client), or a hub client
built before `connect` — the push lands and the `STRICT` answer is the redundant one instead.

**So which of the two MAPs is waste depends on a race the server cannot observe**, and the receiver,
which can observe it, only finds out one round trip after it had to ask. That is the same
undecidability the second pass recorded, now with the missing half of the explanation.

## What was implemented and measured, and why none of it shipped

Both designs were built end to end against the harness and the oracles.

**(a) `Caps.MAP_ONCE` — drop the racing `Pkt.STRICT`.** The server advertises "I push the schema";
a peer that also advertises the bit has its bare `Pkt.STRICT` dropped, because the push already
answers it. A push that was never delivered is repaired by the *client*: everything the server emits
after the peer attached arrives in order, so an answer to the peer's own first packet arriving
without a schema proves the push was lost, and the client re-asks with a forced `[Pkt.STRICT, 1]`
that is never dropped. Hang-free by construction — neither side ever defers a request.

Measured on the loopback (`tapPackets` on both ends, connect + one call):

| Construction order | MAPs before | MAPs after | c2s/s2c packets before | after |
|---|---:|---:|---:|---:|
| server first (`createRpcInProc`, hub) | 2 | **1** | 6 / 10 | **4 / 6** |
| client first (peer's caps lost) | 2 | 2 | 7 / 9 | 7 / 9 |

On the stand's own route it is a **regression**: the void push stays (the server must keep it for
old peers), the STRICT is dropped, and the repair costs one extra c2s frame. It buys two frames
where the push lands and pays one where it does not.

**(b) Deferring the push to the peer's FIRST packet** — the only proof available in this repo that
someone is listening. This removes the waste everywhere, because the push is emitted exactly when it
can be received:

| Route | s2c control packets before | after |
|---|---:|---:|
| socket.io, `await once('connect')` | 9 | **4** |
| loopback, server first | 10 | **6** |
| loopback, client first | 9 | 9 |

It also fixes the second probe row above: a client that never calls `ready()` starts getting its
schema over socket.io. It shipped nothing for two reasons, both hard:

1. **An old peer observes it.** Not the bytes — the deferred push re-emits the same MAP in the same
   position of the s2c stream, because the server emits nothing between construction and the peer's
   first packet — but the fact that the packet now *arrives*. A peer that used to lose the push and
   re-declare its caps afterwards behaves differently. `rpc-caps.ts` requires a peer that does not
   advertise a bit to see the previous wire, and there is no way to know the peer's caps before its
   first packet, which is the packet in question.
2. **`replay/rpc-optional-capability.test.ts` requires the push to be synchronous.** It intercepts
   the `Pkt.MAP` the server emits *inside* `createRpcServerAuto`, asserts no call was probed before
   it, and replays it synchronously. With the push deferred, its `delayedMaps` is empty at splice
   time and `mirror.sync()` never settles — 97/98 oracles. That file is not part of this experiment's
   remit, and its intercept assumption has to be relaxed before the push can move.

## Re-measurement of the unchanged tree

Same host, same Node, same seed `20260729`, 3 runs, fresh process per unit, randomized order.
`RPC_BENCH_FAMILY=connect,connect-auth`, run alone.

| Family | Candidate | connect→ready p50 | c2s frames | s2c frames | c2s RPC packets | s2c RPC packets | ws B | TCP B |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `connect` | `defaults` | 1.427 [1.403…1.445] ms | 7 | 7 | 5 | 6 | 534.82 | 1099.82 |
| `connect` | `plain-json` | 1.437 [1.423…1.449] ms | 7 | 7 | 5 | 6 | 534.82 | 1099.82 |
| `connect` | `caps-all-off` | 1.455 [1.417…1.464] ms | 7 | 7 | 5 | 6 | 534.82 | 1099.82 |
| `connect-auth` | `defaults` | 1.482 [1.465…1.482] ms | 8 | 6 | 6 | 5 | 450.82 | 1017.82 |
| `connect-auth` | `plain-json` | 1.493 [1.44…1.508] ms | 8 | 6 | 6 | 5 | 450.82 | 1017.82 |
| `connect-auth` | `caps-all-off` | 1.44 [1.44…1.57] ms | 8 | 6 | 6 | 5 | 446.82 | 1013.82 |

Per anonymous connection, from the accounting window (30 connects): client `CAPS ×4` (52 B) +
`STRICT ×1` (1 B); server `CAPS ×4` (55 B) + `MAP ×2` (284 B). With in-band auth: client `CAPS ×4`
(52 B) + `HELLO ×1` (44 B) + `STRICT ×1` (1 B); server `CAPS ×4` (55 B) + `MAP ×1` (156 B).
**Identical to the first pass packet for packet and byte for byte** — this pass changed nothing.
Absolute latency is ~0.7 ms lower than the first pass on the same box and is not comparable across
passes; the frame and byte columns are, and they match.

## What this pass licenses

- It **retires the framing** "an anonymous connection sends one redundant MAP". It sends two MAPs,
  of which — on a direct socket.io client — one is delivered and one is discarded by the transport.
  The byte saving is real; the *frame* is already being paid for nothing today.
- It licenses treating "a direct socket.io client that never calls `ready()` has no schema" as a
  **bug of its own**, independent of any byte saving, and one that the deferred push fixes.
- It does **not** license moving the push while `replay/rpc-optional-capability.test.ts` intercepts
  it synchronously, and it does not license design (a) on its own: on the stand's route it costs a
  frame to save none.
- It says nothing new about the data families; they were not run.

## Follow-ups

9. Relax the intercept in `replay/rpc-optional-capability.test.ts` so the schema push can be
   observed wherever it is emitted, then re-take design (b). That is the whole remaining blocker
   on the library side.
10. Decide whether the caps contract's "byte-identical for a non-advertising peer" is meant to cover
    *delivery* as well as bytes. Design (b) satisfies the byte reading and not the delivery reading,
    and no bit can be negotiated before the peer's first packet — which is the packet a schema push
    has to race.
