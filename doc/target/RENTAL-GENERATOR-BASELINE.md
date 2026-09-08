# Independent local rental generators

2026-09-07. Raw results: [rental-generator-baseline.json](rental-generator-baseline.json).
Run optional installed benchmark with RENTAL_BENCHMARK_MS=5000 and
RENTAL_BENCHMARK_GENERATORS=compare.

## Controls

The existing RPC read and measurement loop now live in benchmark-load.ts, shared by the original
in-process mode and fresh child generators. The private benchmark-processes.ts owns worker IPC,
readiness, deadline and cleanup. Workers must report results and exit successfully; a result
followed by abnormal exit fails the run. Error/timeout cleanup terminates owned children and awaits
their exits. No library API or server implementation changed.

Both comparison modes use two active load connections and eight concurrent lanes total. One
generator owns both connections, or two generators own one each. Four lanes are pinned to each
connection in both modes. For two readers, each reader receives one connection; otherwise both
connections target the authority or single reader. Parent catch-up clients close before load.

All child generators are fresh. Each connection warms with 80 reads. After readiness the parent
sets a common start timestamp 150 ms ahead. Actual worker-start skew reached 14 ms in one trial;
aggregate duration spans the earliest start through latest completion, including that skew.
Each worker admits requests for five seconds, then drains its remaining replies. IPC result
collection, warmup and child startup are outside the measured phase. Success percentiles pool
the workers' individual latency samples, not their percentiles.

There are 32 bookings, an 8,611-byte JSON checked payload, three rotated topology trials and
alternating generator order by trial. All servers and generators share the same Windows machine:
Node v24.18.0, Ryzen AI 7 350, 16 logical CPUs, about 16.4 GB RAM. Background load is uncontrolled.

## Results

Medians of three trials. Latency columns are medians of each trial's pooled success percentile.
CPU sums generator process CPU divided by aggregate wall time, as percent of one core equivalent.

| Read target | Generators | Requests/s | p95 ms | p99 ms | Generator CPU % |
| --- | ---: | ---: | ---: | ---: | ---: |
| Authority | 1 | 7,983 | 2.139 | 4.419 | 91.9 |
| Authority | 2 | 8,218 | 1.980 | 3.986 | 95.6 |
| One reader | 1 | 7,765 | 2.187 | 4.404 | 90.0 |
| One reader | 2 | 8,232 | 1.984 | 3.965 | 109.7 |
| Two readers | 1 | 11,104 | 1.527 | 2.958 | 112.8 |
| Two readers | 2 | 13,605 | 1.099 | 1.572 | 171.6 |

All 853,294 measured requests matched the expected payload, with zero errors. Eighteen phases
lasted 5000.37–5014.54 ms. Reader restart/catchup checks also passed.

Splitting the generator improved two-reader median throughput by about 22.5% at the same total
concurrency and load connection count; all three paired trials improved. The smaller authority
and one-reader gains were about 2.9% and 6.0%. The client-side execution arrangement therefore
materially influences these results. This still does not establish which server resource limits
capacity, linear scaling, a maximum throughput or a production latency objective.

Do not directly attribute differences from RENTAL-SUSTAINED-BASELINE.md to generator count:
that older run used a long-lived generator, different connection count for zero/one reader, and
global round-robin dispatch. The paired comparisons in this file hold those controls consistent.
CPU can include process helper threads, so more than 100% does not itself indicate a faulty metric.
Memory snapshots include measurement arrays/caches and are not server retained-heap measurements.

## Verification and review

Full build, installed strict rental types and all ordinary acceptance checks passed before the
final optional comparison. All workers exited successfully; generated-source and whitespace checks
passed. Independent review identified and corrected dispatch differences, idle parent connections,
post-result exit handling and generator-order bias. The first exploratory run used the earlier
controls and is excluded from the saved evidence; only the corrected final run is reported here.

Next capacity investigation would require longer runs, server-side resource measurements and a
controlled concurrency sweep; independent machines would be a separate experiment. Meanwhile the
next product wave returns to concurrent AI task lifecycle, without introducing unapproved APIs.
