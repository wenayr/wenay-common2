# Apartment lock lifecycle wave

## Confirmed example defects

An archived pending unlock survived checkout and was still exposed by `myLock`, although the code
list was empty. The device executed each received command without a deadline check. Separately,
cached keypad codes had no local date check; a midnight transition requires no Store mutation.

The domain now limits unlock to 60 seconds and paid checkout, filters invalid booking/device
bindings, and supplies deadlines for legacy commands. Future setCode provisioning remains valid
until checkout. A small example-owned timing helper is shared by service and device.

The device checks the deadline immediately before the simulated effect and dates at keypad use.
Reports retain their command identity. Exhausting report retries keeps the local outcome instead
of deleting it and allowing another motor action. Closing during readiness or a delay cancels
timers and fences later work.

## Transparency and ownership

These are example fixes, not new library capabilities. Existing authenticated commands, receipts,
projection lines and client placement carry the workflow. No library public interface changed.

`hostBoard.lock.pending` retains records without reported outcomes. `unavailable` counts those
which cannot currently be issued. A late report can still record an earlier action; expiration
does not prove that no physical action occurred. Device `view.outcomes()` distinguishes local
completion from acknowledged reporting. Its memory is not a durable actuator ledger.

## Limits

- UTC dates and reasonably aligned service/device clocks; no clock-skew protocol is added.
- Store projections update on mutations; the local action guard enforces expiry without a patch.
- A motor is simulated. No physical sensor verification, hardware SDK or hardware failover claim.
- After device process restart, surviving server intent could execute again if its earlier outcome
  was lost. Hardware-side idempotency or a durable actuator ledger needs a concrete adapter design.
- After bounded report retries, an unresolved outcome stays visible locally and needs reconciliation.
  This wave does not add a new persistent report queue.

## Verification

Domain policy regression failed first for the restored expired intent, then passed. It covers
boundary timestamps, legacy data, future provisioning, scoped commands, late reports and deadlines
on newly issued commands. Independent device tests cover expiry before/during action, exhausted
report retries, cancelled delays and readiness/heartbeat shutdown races. A real host process serves
a restored-style fixture to an actual RPC device; cached keypad expiry is checked without a patch.
The fixture is seeded state, not itself a disk-recovery test. The existing 30-step process journey
separately verifies actual authority archive recovery with its serving node and device attached.
Full build and installed apartment strict typecheck plus both new suites, account-ID checks and
the existing journey pass. No library implementation changed, so the unrelated full oracle suite
was not repeated in this wave.

Next operations seed: apartment stand `restartLeader()` has no single-flight operation and no
post-stop closing guard, unlike the verified small-jobs stand. Reproduce concurrent restart/close
before changing it. This is a candidate from source inspection, not a confirmed runtime failure.
