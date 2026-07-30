# Store synchronization load experiment — July 2026

This stand measures the high-frequency array-update path in four layers:

1. plain object allocation and array assignment;
2. reactive `Store` assignment and settled patch production;
3. `Store Replay` production and mirror application in process;
4. the same `Store Replay` synchronization over the real RPC and
   Socket.IO/WebSocket path.

The workload repeatedly replaces elements in a 4096-row array. Each new row has
a fixed-width 128-byte ASCII payload plus sequence, price and flags.

Store writes are made in synchronous groups of 128 and drained after each group.
That represents an unpaced producer. The current reactive engine deliberately
coarsens mutations inside an array to the array path, so each drain produces one
patch containing the complete array rather than 128 element patches.

The requested 15/50 MiB target is therefore the fixed-width row payload
represented by those complete-array patches. Changed-row bytes, represented
patch payload, estimated replay bytes and actual WebSocket/TCP bytes are all
reported separately. This makes array-coarsening amplification visible instead
of accidentally turning a nominal 15 MiB test into an unlabelled 480 MiB run.

The warmup fills every array slot before timing. All candidates verify the final
array, and replay candidates additionally verify the mirror and exact
produced/applied patch counts.

## Metrics

- operations, changed-row MiB/s and represented-patch MiB/s;
- process CPU per operation and aggregate CPU utilization;
- event-loop delay and GC activity;
- heap/RSS delta, sampled peak and post-GC retained delta;
- Store source/replay/applied batch and patch counts;
- physical WebSocket frames and bytes;
- accepted TCP bytes and WebSocket framing bytes;
- Store patch amplification relative to changed rows;
- protocol amplification relative to represented patch payload;
- end-to-end wire amplification relative to changed rows.

The Socket.IO server and client run in one fresh Node process over loopback,
forced to WebSocket with compression disabled. CPU includes both endpoints.
Loopback isolates serialization, synchronization and transport machinery; it
does not reproduce Internet RTT, packet loss, TLS or remote-host capacity.
Post-GC heap is the useful retention signal; process RSS may stay committed to
Node's allocator after objects have been collected and is not by itself a leak.

## Run

```powershell
npm run experiment:store-load
```

Defaults are three fresh-process runs at both 15 MiB and 50 MiB:

```powershell
$env:STORE_LOAD_RUNS='3'
$env:STORE_LOAD_TARGETS_MIB='15,50'
npm run experiment:store-load
```

Useful iteration controls:

```powershell
$env:STORE_LOAD_RUNS='1'
$env:STORE_LOAD_TARGETS_MIB='1'
$env:STORE_LOAD_CANDIDATE='store-replay-socket'
npm run experiment:store-load
```

Other controls are `STORE_LOAD_ARRAY_LENGTH`, `STORE_LOAD_PAYLOAD_BYTES`,
`STORE_LOAD_BATCH_SIZE`, `STORE_LOAD_WARMUP_MIB` and `STORE_LOAD_SEED`.

The benchmark intentionally lives outside `src/`: it changes no package API and
adds no runtime dependency to the library.
