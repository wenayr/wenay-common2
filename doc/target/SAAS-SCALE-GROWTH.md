# SaaS growth cycle — 2026-09-06

## Reusable result

Existing `Scale.createClusterClient` owns placement, replicated roster following and replica
handoff. Existing `Scale.createStoreNode` owns serving, reader facts, registration and departure.
The application supplies the state/commands and transport adapter. This cycle fixes these
resources rather than adding another coordinator or copying their logic into a SaaS.

Two library defects were reproduced before fixing them:

- Default balance stalled at one-to-two equal-capacity growth: the old node's load is exactly
  twice its fair share. Equality now permits a beneficial move; one reader alone does not bounce
  between equal nodes. The default threshold, cooldown and public signatures are unchanged.
- A local `leave()` announced departure only after its grace, and an unresolved goodbye could
  block shutdown indefinitely. It now withdraws immediately while keeping its replica alive for
  the grace. The host shutdown callback runs at the deadline even if the control plane does not
  answer. `close()` cancels the callback. An unreachable directory still needs stale-row expiry.

## Executable acceptance

Run `npm run test:scale-process`; run `npm run test:scaffold` after building to repeat from the
installed tarball in a separate directory. Both use the normal service definition and process
hosts. `process-leader.ts` is a private IPC test adapter over the existing leader drain control;
it does not add a network administration endpoint. `process-node.ts` similarly calls the existing
local `leave()` path used by process signals.

1. Start an authority, one serving process and a consumer; apply an acknowledged command.
2. Attach four more real followers and wait for the node's reader count to reach five.
3. Start a second serving process. Enable the existing balance policy and wait for the original
   consumer's actual route to move. Check its Store identity, command receipt and subscription.
4. Drain the serving process through authority control. Assert that the reader has moved while
   that process is still alive, then verify its successful exit.
5. Add replacement capacity, crash the other process, reconnect an offline reader and restart a
   node, then request that node's local `leave()`. Both departure paths move the consumer before
   process exit. The original subscription sees every awaited checkpoint once, in order.

The runner reports node startup-to-route time, planned evacuation time and crash-to-confirmed
write time. These are localhost scenario timings with five readers and accelerated balance
checks, not throughput benchmarks or production latency guarantees. Desired placement and actual
route are distinct during catch-up; socket count is not reader count.

One installed-package run on the development machine measured: growth 476 ms, planned drain
31 ms, crash through confirmed command 62 ms, local leave 60 ms. Published serving-reader counts
changed from `5` to `4 + 1`; the policy relieves overload rather than enforcing an exact even split.
These values describe that run only. Every move reused the original Store and receipt space.

## Production boundaries still requiring work

- This is horizontal **read** scaling. Commands still serialize at one authority. Adding mirrors
  does not increase write throughput or prove authority failover, fencing or write partitioning.
- Node `weight` is an existing capacity input; it is not measured CPU/memory capacity. Vertical
  sizing needs repeatable workloads, heap/CPU measurements and machine limits. No such speedup
  is claimed by this cycle.
- Most role-filtered SaaS views expose plain replay lines; the cluster client expects replica
  descriptors. The template still composes their placement separately. A small shared placement
  resource or a deliberately compatible view descriptor needs API discussion; exposing the full
  replicated business Store to bypass this boundary would leak private data.
- Directory loss, slow readers, connection fan-out, graceful-departure deadlines and sustained
  write traffic need separate load/failure budgets. The balance loop currently consumes last-known
  directory load facts during a roster outage; this cycle does not establish that policy's safety.
- Host shutdown, container scheduling, TLS, persistence provisioning and operational access remain
  host responsibilities. The private test IPC is not a deployment control service.

Focused evidence: `observe/scale-client-balance.test.ts`, `observe/store-node-local-leave.test.ts`,
`observe/store-node-readers.test.ts` and `experiments/wenay-scaffold/multiprocess-check.ts`.

Completed verification: full build; unchanged generated declarations for both modified library
resources; `npm test`; all 167 ordinary oracles; installed scaffold strict typecheck and process
scenario; all four installed SaaS examples (`npm run test:examples`).
