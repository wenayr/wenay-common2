# Smart-home probe: completed stages and remaining seams

## Completed, 2026-09-06

- Independent authoritative Store per household and device-to-household addressing.
- Lazy shared household projection, exact subscriber count, idle timeout, stable facade and
  increasing sequence across idle reclamation. No projection work while unused.
- Existing ReplayStorage port per household; synchronous archive flush before record returns.
- Two real owner processes with explicit household placement and gated reader/device RPC.
- Hard owner crash: the other household keeps writing; saved readings restore; the existing
  reader Store accepts a fresh lower-sequence snapshot and then live events.
- Resource checks precede the process scenario: close beats pending restart, concurrent restart
  requests share one process, and a reader cannot close the shared source.
- A short `example.ts` now demonstrates typed Store subscription and one device command;
  command acknowledgement and display delivery remain explicit separate outcomes.

Consumer follow-up: `oracle/realsocket/scaffold-client-lifecycle.spec.ts` covers template shutdown
during roster loading and external login, and closing/reopening an individual view. Pending
resources are disposed, late attachments are ignored, and the existing hub provider is the sole
initial login caller. This follow-up changes the scaffold, not the public library contract.
Verified the follow-up with a full build, all three focused socket scenarios, and installed-package
typechecks and execution for rental, pizzeria, apartments and smart-home (`npm run test:examples`).

Evidence lives in `examples/smart-home` (all four checks run by `npm run check`),
`observe/store-replay-restarted-source.test.ts` and
`oracle/realsocket/store-replay-delegated-listen.spec.ts`. The package-consumer gate installs the
tarball outside the repository, typechecks and executes the same checks.

Verification completed: full build (Listen declarations unchanged), `npm test`, all 165 ordinary
oracles, and `npm run test:examples` for rental, pizzeria, apartments and smart-home. The final
compiled artifact also passed the focused Listen regression and installed smart-home check.

## Library defects fixed

The first probe fixed coercive `storeDiffPatches` comparison. The lifecycle stage exposed failed
Listen admission retaining a subscriber and its close hook; removal-hook failure could also
leave stale fast dispatch. The shared core now rolls back only the failed registration, preserving
reentrant replacement under the same key. Public signatures remain unchanged.

## Next changes that need design, not a new guessed public API

1. **Lazy replay metadata.** The library's original wire facades carry internal metadata for
   automatic RPC backpressure. A stable lazy facade can be built from public Listen/Store seams,
   but there is no public addressing surface for transferring that metadata. Before graduating
   the example wrapper, decide whether a reusable lazy replay resource or an explicit metadata
   transfer operation belongs in the public API. Verify slow readers, reconnect and idle teardown
   together. Do not copy internal symbol names into application code.
2. **Owner transfer.** The stand's static home → process map demonstrates partitioned writes,
   not distributed coordination. Automated placement changes need a real ownership/fencing
   resource, durable epoch allocation and migration/recovery policy. Existing Scale and
   Replay resources should remain the foundation; no second election protocol is justified here.
3. **Large deployments.** Idle projections are reclaimed, but configured household Stores and
   handles live until service close. For many inactive homes, define authoritative storage
   admission/eviction separately from reader-line eviction and benchmark the chosen adapter.
4. **Product identity and device delivery.** Token issuance is test-owned. Offline writes fail
   visibly; this probe does not provide a device outbox, automatic retry of ambiguous commands,
   physical-device transactions, refunds, or a production identity provider.
5. **Durable acknowledgement facade.** `createDurableStoreReplay` already composes the archive
   and replay resource, but does not expose the archive's `flush`. The example therefore uses
   the lower-level composition to acknowledge `record` only after flushing. Discuss forwarding
   the existing flush operation before replacing this code with the wrapper.
6. **Strict initial readiness.** Replay subscription `ready` settles on failure and closure too.
   The reader explicitly checks its recorded failure after awaiting it. A separate strict
   readiness promise could remove that choreography; changing existing `ready` rejection
   semantics would be a compatibility change. Preserve this distinction in consumer examples.

The apparent undefined/null replay failure during integration was a malformed example facade:
`{line: {on: listen.on}}` introduced an extra RPC subscription node. Relaying the recognized
Listen block fixes it without modifying the library's replay argument contract.
