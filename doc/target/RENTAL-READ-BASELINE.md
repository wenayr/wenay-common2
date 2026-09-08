# Rental bounded read baseline

2026-09-07. Optional `npm run benchmark` in the installed rental example. Raw trials and machine
metadata: [rental-read-baseline.json](rental-read-baseline.json).

## Workload

Nine fresh ephemeral stands: three trials each of authority-only, one reader and two readers.
Mode order rotates per trial. Each contains 32 non-overlapping bookings, verified against the
authority. Requests read `replica.replay.keyframe()` over Socket.IO/RPC and validate the snapshot
patch payload against the authority. Sequence/timestamp envelope fields are not compared.

Each endpoint gets 80 warmup requests. The measured phase has 600 requests and concurrency 8
TOTAL. Dispatch is explicitly round-robin; the authority receives no measured requests in reader
modes. This is not automatic placement. Startup measures stand creation to its ready endpoints;
RPC connection/catchup is recorded separately. Restart includes stopping/replacing reader 0,
opening a fresh client and verifying restored data; it is not existing-client recovery time.

## Observed results

Windows x64, Node v24.18.0, AMD Ryzen AI 7 350, 16 logical CPUs, approximately 15.3 GiB RAM.
Client and all server processes share this machine. Values below are medians of three trials;
p95 column is the median of trial p95s, not one pooled percentile.

| Measured endpoints | Successful reads/s | Trial p95 median, ms | Stand startup, ms | Reader restart-to-data, ms |
| --- | ---: | ---: | ---: | ---: |
| Authority only | 10,170 | 1.393 | 347 | — |
| One reader | 10,215 | 1.396 | 744 | 434 |
| Two readers | 10,566 | 1.607 | 1,149 | 423 |

All 5,400 measured requests succeeded with matching data. Two-reader trials completed exactly
300 requests on each endpoint; other modes completed 600 on their single endpoint.

Measured phases lasted only 49–66 ms. These are short local samples, not sustained throughput,
saturation or an SLO. Results do not establish meaningful speedup from the second reader; trial
variation is larger than the median difference. Longer steady-load runs, independent load clients,
payload/concurrency sweeps and server CPU/memory evidence are needed before a capacity conclusion.
No write scaling, production network or persistence throughput is measured.

## Integration lesson

The first probe incorrectly assumed the leader's legacy `view()` existed on readers; the installed
run rejected that call. The benchmark now uses their shared replica facade. This was a consumer
assumption, not a reason to silently add methods to the library or every node.

Full build, installed strict typecheck, durable/stand/business checks and optional benchmark pass.
The benchmark is not added to ordinary correctness gates. Public library interfaces are unchanged.

Next investigation follows the user's dynamic API question: compare shared entity dispatch with
per-object facades at fixed object/subscriber counts, keeping any prototype private and measuring
memory/creation/call/cleanup costs before discussing a public interface.
