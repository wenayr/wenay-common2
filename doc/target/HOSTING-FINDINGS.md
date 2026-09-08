# Automated hosting product wave

## Delivered

`examples/hosting` is a copyable local process-hosting prototype. `npm start` leaves a working
site URL running; `npm run example` deploys v1, updates to v2 and rolls back, then closes everything.
Only bundled trusted worker releases are executable. `Contract.createContractRuntime` owns
preparation, binding replacement, per-request leases, draining and rollback. The example owns
HTTP, child processes, readiness probes and explicit tenant-to-slot addressing.

The facade is deliberately small: `control.deploy/rollback`, `source.endpoint`,
`view.status/history/processes`, `events.changed`, and `close`. It is example composition, not an
additional public library export. Each update preserves the gateway URL; a request already leased
to v1 completes on v1 while new requests reach v2. A bad health probe keeps the old release active.

## Library result

A failing-first regression reproduced loss of `onFail` during asynchronous `acceptSession`:
a dead candidate could replace a healthy active binding. The runtime now subscribes before the
readiness policy, rejects failed preparations and retains the old binding. Pending candidate
cleanup owns its failure listener, so close detaches it immediately. Public declarations unchanged.

## Verification

- Product source check: health failure, same URL, overlapping request/update, drain, rollback,
  two independent sites, rollback remains effective when another site deploys, all processes exit.
- Close during process preparation: no activation, deployment rejects, close waits for child exit,
  concurrent closes share one completion.
- Installed tarball: strict TypeScript check and product checks outside the repository.
- Persistent entrypoint: actual HTTP 200 and v2 HTML, Ctrl+C shutdown, no remaining source processes.
- Library: 11 lifecycle cases, baseline Contract cases and real-socket Contract cases; full build
  and `npm test` passed; all 167 ordinary oracles passed in the aggregate run.
- Existing rental, pizzeria, apartments and smart-home installed checks passed. The first installed
  hosting check caught optional `process.disconnect` typing; corrected and rerun successfully.

## Next boundaries

This is not a secure untrusted-code host, distributed deployment controller or cloud provisioner.
No TLS/DNS, billing, OS tenant isolation, durable deployment inventory or database migrations are
claimed. App releases are local processes, not replicas across machines. Old offer/resource records
remain for diagnostics and rollback in this small example; many successive deployments need an
explicit retention policy. Health deadlines and drain bounds are explicit host/runtime settings.

Keep provider/provisioning adapters separate from Contract. Before growing the host, decide durable
desired-state ownership and recovery, bounded deployment history, rollback retention and actual
capacity measurements. Existing dynamic-runtime architecture remains canonical.
