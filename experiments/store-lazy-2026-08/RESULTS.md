# Lazy Store line results — 2026-08-03

Environment: Node v24.18.0, Windows 11 (10.0.26200), AMD Ryzen AI 7 350, 16 logical CPUs.
Link: 131 072 B/s per direction, 80 ms one-way delay, real socket.io + RPC through the
metered relay. Churn tick 250 ms. Read budget 256 KiB (library default) for both runs.

| Profile | Candidate | firstData | converged | wire KiB |
|---|---|---:|---:|---:|
| symbols-350-churn-120 | keyframe | 397 ms | **475 ms** | **35.4** |
| symbols-350-churn-120 | lazy | 415 ms | 769 ms | 38.1 |
| symbols-350-quiet | keyframe | n/a\* | **387 ms** | 26.7 |
| symbols-350-quiet | lazy | n/a\* | 401 ms | 26.8 |
| board-20000-churn-100 | keyframe | 11 579 ms | **14 086 ms** | 1 758.5 |
| board-20000-churn-100 | lazy | **718 ms** | 18 800 ms | **1 646.1** |

\* Both candidates deliver a small Store inside one window, so the 5 ms first-key poller
never observes a partially populated mirror. A probe limitation, not a delivery failure.

## The verdict

**On a large Store the lazy line is the better transfer: first paint 718 ms versus
11 579 ms — 16x faster — while sending 6 % FEWER bytes.** The price is 1.33x slower full
convergence (18.8 s versus 14.1 s), which is close to the floor: 1.6 MiB over this link
costs ~13 s of pure line time, and a longer fill inevitably collects live re-sends of keys
that changed after they were sent.

**On a small Store it is at parity when quiet (401 ms versus 387 ms) and ~1.6x slower
under churn.** No first-paint advantage exists there, because a 350-key keyframe is
already cheap. That is the boundary of where this surface belongs, not a defect.

## What measurement changed, and what it cost

Three implementation faults were caught by this stand before release. Each was real, and
each is fixed:

| | Before | After | Fix |
|---|---:|---:|---|
| Wire bytes, 20 000 keys | 4 924 KiB | **1 646 KiB** | compact key/value map per chunk instead of one `{path, value, exists}` object per key |
| Convergence, 20 000 keys | 112 632 ms | **18 800 ms** | read budget raised above the link's bandwidth-delay product |
| First paint, 20 000 keys | 910 ms | **718 ms** | stateless resumable cursor — no `open()` round trip before the first byte |
| Resume after disconnect | full restart | continues | cursor is `{key, revision}` held by the subscriber |

**Encoding.** One patch object per key repeated `path`/`value`/`exists` twenty thousand
times, while a keyframe writes its shared structure once. A plain key/value map per chunk
closed a 2.8x byte gap and then went past it.

**Bandwidth-delay product.** The original 16 KiB read budget was *below* the link's
product (128 KiB/s x 160 ms RTT ~ 20 KiB), so the link sat idle between requests and the
fill was latency-bound rather than bandwidth-bound. This is the rule when tuning
`readBytes`: below the product the link idles; far above it a background fill stops being
polite.

**A confound worth recording.** One intermediate run appeared to show the stateless cursor
regressing convergence to 43 s. It was not the redesign: that run used the stand's old
16 KiB default while the previous run had been given 256 KiB explicitly. The stand default
now matches the library default so the two cannot drift apart again. A benchmark whose
defaults disagree with the code under test measures the benchmark.

## Reading the small-Store rows

Keyframe wire bytes for `symbols-350-churn-120` moved between runs (44.2 then 35.4 KiB)
because churn timing shifts how many live envelopes land inside the measured window. Treat
small-Store byte columns as approximate; the 20 000-key rows are the stable signal.

Reproduce with `npm run experiment:store-lazy`.
