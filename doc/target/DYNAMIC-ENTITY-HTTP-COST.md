# Entity API over HTTP: measured registration and calls

2026-09-07. Private installed rental probe, `npm run probe:http`. Raw trials:
[entity-http-probe.json](entity-http-probe.json). No public API or adapter lifecycle changed.

## Comparison

Both modes use the same shared entity Map and owner checks from the previous probe. The existing
createHttpFacadeServer mounts either one `/entity/read` handler with an ID argument or one bound
`/entity/e<ID>/read` handler per object. The ID location differs deliberately; the operation and
returned data match. The per-route mode does not also allocate the previous eager entity facades.

Each of 18 fresh GC-enabled processes contains its own loopback HTTP host and fetch client.
Entity counts: 100/1,000/10,000; three trials per mode, alternating mode order. Setup memory starts
AFTER base HTTP and rows exist, so registration deltas include route objects, bound closures,
middleware registration and adapter enumeration, not the initial entity data.

Twenty requests warm sampled IDs. Two hundred measured requests, total concurrency four, span
the full ID range including the first and last registered routes. This samples the range, not
every object at larger sizes. Timings include fetch, response parsing and client validation.
HTTP bearer fixtures distinguish alice and bob; the server prepends the verified account to
arguments and ignores client-supplied account fields. No production identity provider is claimed.

## Results

Windows, Node v24.18.0, AMD Ryzen AI 7 350, 16 logical CPUs. Medians of three trials; p95 is the
median of trial p95s, not a pooled percentile.

| Objects | Strategy | Routes | Registration ms | Registration heap bytes | 200 requests ms | Trial p95 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 100 | Shared | 1 | 1.15 | 31,864 | 118.96 | 3.86 |
| 100 | Per-object | 100 | 2.43 | 387,368 | 139.16 | 4.68 |
| 1,000 | Shared | 1 | 1.17 | 31,888 | 172.42 | 13.48 |
| 1,000 | Per-object | 1,000 | 13.92 | 3,197,392 | 125.59 | 3.71 |
| 10,000 | Shared | 1 | 1.19 | 30,696 | 138.76 | 8.44 |
| 10,000 | Per-object | 10,000 | 104.61 | 30,622,072 | 390.38 | 14.08 |

At 10,000 objects the additional route setup retains about 29.2 MiB versus about 30 KiB for a
shared handler, excluding common row/server storage. Registration cost clearly grows in this
per-route implementation. Request timings are noisier: the 1,000-object samples reverse the
ordering. Do not infer a universal latency ratio. At 10,000 routes this sample's median request
phase is slower, but sustained capacity, independent clients and CPU profiles remain unmeasured.

All 3,600 measured requests returned matching values. Anonymous access, another owner, account
spoofing and reads after deletion were rejected outside the timed phase. Median server close
times were below 1 ms here, with no deliberately slow connections; the earlier transport checks
cover its deadline separately. Post-traffic and released heap values include HTTP client/JIT
caches and are recorded raw, not interpreted as an exact leak count.

## Lifecycle consequence

Deleting a row does not remove its registered route: that path still reaches the handler, which
rejects the missing entity. The existing adapter exposes route inventory, not unregister/replace.
Repeatedly creating per-object routes is therefore also a lifecycle problem, not merely a memory
choice. Do not remove Express internal router entries as an undocumented workaround.

## Proposed direction

Keep a fixed transport surface for a resource TYPE, with entity identity supplied in addressing.
Creating/removing an entity changes the data registry; it should not rebuild the HTTP router.
An optional bound client handle can provide object-like ergonomics while forwarding to those
shared handlers. Allocate subscriptions only while used, as measured in the previous probe.

This can first be demonstrated with existing adapters and explicit business commands. A reusable
public facade still requires discussion of identity generations, deletion/recreation, permissions,
operation receipts and schema versions. Dynamic user-defined TYPE schemas are a separate question
from new instances of an existing type, and runtime code execution is outside both measurements.

## Verification

Full build, installed strict types, all ordinary rental resource/stand/business checks and all
18 HTTP measurement children pass. Generated copies and scoped whitespace checks pass. The
probe is optional and does not add timing thresholds to correctness gates. RPC schema walking,
OpenAPI generation, database costs and remote-network behavior remain outside this result.
