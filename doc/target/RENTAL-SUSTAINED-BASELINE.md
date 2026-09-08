# Sustained local rental reads

2026-09-07. Raw results: [rental-sustained-baseline.json](rental-sustained-baseline.json).
Run the installed rental example's optional benchmark with RENTAL_BENCHMARK_MS=5000.
The default without that setting remains 600 requests; accepted durations are 1000–10000 ms.

## Method

Same existing stand and RPC replica keyframe reader as the short baseline. Each trial has 32
bookings and an 8,611-byte JSON representation of the checked payload (excluding wire framing).
There are 80 warmup reads per endpoint, eight concurrent request lanes total and explicit
round-robin dispatch. Authority is excluded from reads when readers are present. One generator
process and the server child processes run on the same machine; this is closed-loop load.

Three trials rotate order across authority-only, one-reader and two-reader modes. Each phase
admits requests for five seconds and then drains outstanding responses; actual durations were
5000.18–5004.13 ms. Every successful response is checked against the authority's reference payload.
Correctness/installed type checks run before this optional measurement, and reader restart/catchup
is checked after each reader-mode phase. No timing thresholds are correctness gates.

Windows x64, Node v24.18.0, AMD Ryzen AI 7 350, 16 logical CPUs, about 16.4 GB RAM.
This was a local run without controlled background-machine load.

## Results

Medians of three trials; percentiles are medians of trial percentiles, not pooled percentiles.

| Read target | Successful requests/s | p95 ms | p99 ms | Generator CPU, % of one core equivalent |
| --- | ---: | ---: | ---: | ---: |
| Authority | 9,594 | 1.404 | 1.786 | 86.2 |
| One reader | 9,368 | 1.448 | 1.840 | 88.4 |
| Two readers | 12,161 | 1.255 | 1.718 | 98.8 |

All 464,833 measured requests succeeded with matching data; zero errors. Unlike the earlier
49–66 ms phases, these longer phases show a consistent local advantage for two readers in all
three trials. Their median throughput is about 29.8% above one reader and 26.8% above authority-only.
One reader did not outperform the authority in this workload. One-reader trial 2 had a p99 of
4.294 ms; raw trials retain that variation instead of hiding it in a combined percentile.

## Interpretation and limits

This demonstrates a benefit for this payload and fixed concurrency on this machine. It does
not establish linear scaling, server saturation, a capacity ceiling, write scaling or an SLO.
The generator approaches one CPU-core equivalent with two readers. That suggests investigating
generator limitations next; server CPU was not measured, so it does not identify the bottleneck
conclusively. CPU is process CPU divided by wall time, and can include helper threads.

Latency includes RPC handling, client decoding and payload validation. CPU/memory snapshots are
for the generator only. Heap values include collected latency samples and normal runtime caches;
no forced GC or retained-server-heap measurement was performed. Five seconds is more informative
than the original short phases but is not a long-running soak test or an independent-machine load test.

Next measurement: separate generator work into a bounded number of independent client processes
while preserving total concurrency and payload. Compare against this baseline and report their
placement; do not increase concurrency and change generator topology in the same comparison.

Verification: full build, installed strict rental types and all ordinary checks, nine sustained
phases with zero errors and successful reader restart/catchup; generated copies match sources.
No library runtime implementation or public interface changed in this wave.
