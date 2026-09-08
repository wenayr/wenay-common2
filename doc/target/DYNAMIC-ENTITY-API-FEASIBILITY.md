# Dynamic entity API: first measured boundary

2026-09-07. Private experiment in the installed rental example; no library API proposed here is
implemented or approved. Reproduction: `npm run probe:entities`. Raw trials:
[entity-api-probe.json](entity-api-probe.json).

## What was compared

Both modes use identical Map rows, per-call owner checks, copied values and the existing
createListenCore. Shared mode addresses one implementation by ID. Facade mode additionally allocates
one nested view/control/events object with bound closures per entity and looks it up by ID on calls.
Subscriptions are lazy in both: final unsubscribe, removal and close release their stream.

Matrix: 100/1,000/10,000 entities; zero or 100 subscribed entities; three fresh processes per mode
and cell, 36 processes total. Each child runs with --expose-gc. Heap is sampled after collection,
before creation, after creation, after subscription and after cleanup plus a macrotask. Resource
heap includes rows/maps in both modes; the difference estimates this facade implementation's cost.
It is not an exact per-object byte size. Calls use 10,000 warmup reads, 100,000 measured reads and
20,000 writes. Changed values and exact notification counts are checked.

## Results

Windows x64, Node v24.18.0, AMD Ryzen AI 7 350, 16 logical CPUs. Medians of three processes,
without subscriptions:

| Entities | Shared retained heap delta, bytes | Facades retained heap delta, bytes | Shared create, ms | Facades create, ms | Shared 100k reads, ms | Facades 100k reads, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 125,688 | 163,856 | 0.051 | 0.197 | 2.324 | 3.266 |
| 1,000 | 88,512 | 1,598,144 | 0.098 | 1.140 | 2.752 | 3.984 |
| 10,000 | 1,099,592 | 16,284,832 | 0.852 | 18.381 | 3.098 | 6.130 |

At 10,000 entities, eager facades add approximately 14.5 MiB in this implementation. Small shared
heap deltas are visibly noisy (100 entities exceeds 1,000); do not interpolate them or present
these numbers as a universal memory formula. Local invocation remains a small synthetic loop;
these timings are NOT network API latency or SaaS throughput.

Adding 100 subscriptions at 10,000 entities retained approximately 230,700 extra bytes in either
mode, with median registration 0.49 ms shared / 0.64 ms facades. Each such run delivered exactly
200 callbacks for the 20,000 cyclic writes. Streams therefore follow active subscriptions, not
total entity count. These are one-listener-per-entity samples; large fan-out is not measured.

All logical counters are zero after close. Collected heap does not return exactly to the baseline:
engine/JIT/cache effects and measurement noise remain, including negative deltas in raw samples.
Counter cleanup is verified; absence of every possible memory leak is not established.

## Recommendation

Use shared type-level handlers and IDs as the default storage/execution model. Give a caller an
optional convenient bound handle only when it actually uses that entity; avoid eagerly retaining
facades for every stored row. Allocate observation resources on demand and release them on last
unsubscribe. An entity can have an addressable API without dedicated routes, timers or a process.

Before discussing a public interface, specify these semantics explicitly:

1. Ownership is checked on every read/write/subscribe, not only when a handle is constructed.
2. Deletion invalidates handles and subscriptions; recreating the same ID needs an explicit
   generation/identity rule. The current probe tests deletion, not recreate-with-same-ID behavior.
3. Business commands, operation identity and schema versions remain explicit. Generating an API
   does not infer booking/payment rules or make writes durable.
4. Runtime-defined schemas require runtime validation; static TypeScript cannot know a definition
   created after compilation without code generation or a generic validated client contract.

Existing HTTP facade generation registers routes from a supplied object but has no removal or
replacement surface. This experiment does not justify repeatedly registering it per entity.
Next measure real transport dispatch and schema setup separately before selecting any new seam.

## Verification and boundaries

Independent checks cover both modes' read/write/subscribe/remove ACL, copied reads and per-listener
event copies, final unsubscribe, deletion and repeated close. Build, installed strict typecheck,
existing rental correctness checks and all 36 measurement children passed. Public exports unchanged.

Not measured: RPC/HTTP routing or schema walk, OpenAPI regeneration, database IO, durable writes,
tenant isolation across processes, dynamic code execution or subscription fan-out under network load.
