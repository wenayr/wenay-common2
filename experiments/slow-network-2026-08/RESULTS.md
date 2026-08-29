# Slow-network experiment results — 2026-08-02

Environment: Node v24.18.0, Windows 11 (10.0.26200), AMD Ryzen AI 7 350, 16 logical CPUs.
Options: defaults (see README). Deflate = `perMessageDeflate: {threshold: 1024}` on the
server plus `perMessageDeflate: true` on the Node client. Wire bytes are the measured
server→client TCP bytes through the relay, WebSocket framing included.

## Pass 1 — wire bytes and CPU, fast link

| Payload | JSON B | Wire B off | Wire B on | Byte ratio | CPU µs/msg off | CPU µs/msg on | p50 off | p50 on |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| small | 90 | 104.5 | 9.1* | 11.5×* | 75 | 545 | 0.09 ms | 0.38 ms |
| medium | 304 | 320.5 | 14.0* | 22.8×* | 320 | 475 | 0.08 ms | 0.38 ms |
| rows-1000 | 151 673 | 151 694 | 12 083 | **12.6×** | 3 133 | 6 267 | 2.41 ms | 5.80 ms |

\* The small/medium ratios are flattered by repeated near-identical payloads
sharing one deflate context (see README interpretation rules). The honest
headline number is the single-message `rows-1000` row: **12.6× fewer bytes for
2× CPU**, with per-message latency still in single milliseconds.

Deflate costs are real but bounded: ~0.3 ms added p50 on tiny messages, 2×
CPU on a 148 KiB message. On loopback/LAN where bytes are free, deflate is a
pure loss — which is exactly what the July stands concluded. The next two
passes show the inversion on a slow link.

## Pass 2 — one-shot delivery over 131 072 B/s (≈1 Mbit/s), 80 ms one-way

| Payload | JSON B | Wire B off → on | Delivery off → on | Speedup |
|---|---:|---:|---:|---:|
| rows-1000 | 151 673 | 151 704 → 12 676 | 1 343 ms → 280 ms | **4.8×** |
| keyframe-5000 | 821 158 | 821 198 → 77 671 | 6 469 ms → 792 ms | **8.2×** |

On a bandwidth-constrained link the byte saving converts almost directly into
delivery time. This is the same magnitude the removed binary codec promised
(43–49 % bytes) — deflate delivers 90 %+ byte reduction on this traffic shape
while keeping the native-JSON CPU path, confirming the decision to drop the
binary wire.

## Pass 3 — ping starvation, 32 768 B/s, scaled timers (pingInterval 300 ms)

Server pushes one 2000-key keyframe (~319 KiB JSON, ~10 s of link time):

| Variant | Outcome |
|---|---|
| `pingTimeout` 1 s (scaled default), deflate off | **disconnect `ping timeout` at 1.21 s — payload never delivered** |
| `pingTimeout` 30 s, deflate off | delivered at 10.06 s, connection survives |
| `pingTimeout` 1 s, deflate on | delivered at 1.06 s (31 370 wire B), connection survives |

This is the disconnect/reconnect storm mechanism on slow links, reproduced: a
single frame that occupies the link longer than the heartbeat budget starves
the server→client ping queued behind it, the client declares `ping timeout`,
reconnects, catch-up resends a large frame, and the cycle repeats. Two
independent cures, both measured: raise `pingTimeout` past the largest legal
frame's transmission time, or shrink the frame below the budget (compression
now; keyframe chunking as the structural fix).

Production mapping: with default `pingInterval` 25 s / `pingTimeout` 20 s, any
frame that occupies the link longer than ~20–45 s (phase-dependent) kills the
connection. At 1 Mbit/s that is any frame ≳2.5 MiB — the ~3.3 MiB Store
keyframe measured in `doc/RECOMMENDATIONS.md` is inside the kill zone.

## Conclusions

1. `perMessageDeflate` is now measured: enable it (server `{threshold: 1024}`)
   for any deployment where bandwidth, not CPU, is the ceiling. Keep it off for
   loopback/LAN benchmarks and for connections carrying already-compressed
   binary media.
2. Raise server `pingTimeout` (60 s is a sane slow-link default) so one large
   frame cannot starve the heartbeat.
3. Keyframe chunking (`doc/RECOMMENDATIONS.md`, replay scaling follow-ups)
   graduates from a scaling nicety to the structural fix for reconnect storms:
   chunks keep every frame below the ping budget without relying on
   compression ratios.
4. Still unmeasured here: real packet loss and retransmit behavior on the
   target route, and browser-side deflate memory on many concurrent
   connections. Repeat over the expected deployment route before hard-coding a
   production default.

Raw run output (`##RESULT##` JSON) is reproducible via `npm run experiment:slow-network`.

## Chunked keyframe (2026-08-28)

Live stand `chunked-keyframe.ts` (100 000 keys × 30 B ≈ 4.49 MB keyframe; 524 288 B/s = the
1 Mbit/s model time-scaled 4×, scaled ping timers 300/1000 ms, chunk budget 256 KiB; the stand's
relay copy delivers FIFO — bench's per-chunk timers can reorder sub-ms deliveries at this rate):

- Monolithic (`chunkedKeyframe: false`): 8.56 s of line occupation vs the 1.3 s heartbeat budget
  (6.6×) — `ping timeout` observed at ~1.2 s, catch-up never completes. Both proofs shipped:
  the observed kill and the occupation arithmetic.
- Chunked (default ON), same store, same link: 19 chunks, largest message 240 733 B (459 ms of
  line), monotone progress 1..19, zero disconnects, converged in ~11.0 s, mirror deep-equals the
  source and the live tail resumes from the snapshot seq.
- Socket killed at 10/19 chunks: ONE sync survives, a fresh `begin` restarts progress, converges
  in ~17.2 s, and no partial snapshot is ever exposed.

Conclusion: the maximum frame size is now a protocol property — the negotiated chunk budget — not
a dataset property; the dataset that kills the monolithic catch-up converges chunked on the same
link, with the heartbeat breathing between pulls.
