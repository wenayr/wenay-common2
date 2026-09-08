# Small jobs marketplace wave

## Product

`examples/small-jobs` is a copyable marketplace with two customer and two worker demo accounts.
The normal start launches a leader and serving nodes with the existing panel and API docs.
The finite example performs post → propose → assign → submit → accept using the existing
`createServiceClient` directly. No new session wrapper, receipt system or workflow engine was added.

The domain defines roles, schemas, synchronous state transitions and three projections: a public
board, a customer's own jobs/proposals and a worker's own proposals/assigned work. Contact details
are released only to the selected worker; delivery results stay out of the public board and the
other workers' views. Two competing assignments, or assignment versus cancellation, have one winner.

Serving-node restart preserves the command receipt and the original board Store receives a new
post afterward. The authority stays alive in this check; durable authority recovery is not claimed.
The stand resource separately verifies single-flight restart, close beating a pending restart and
no remaining child processes. It reuses the previously tested smart-home ownership pattern.

## Cross-product defect found

`requestId` is unique within an account, not globally. Rental, pizzeria and apartments built object
IDs from only `requestId`, so two valid callers could overwrite one another's bookings, orders or
payment records despite correctly scoped library receipts. Facade-level tests reproduced the bug.

New IDs use SHA-256 over the existing `Command.commandReceiptKey(account, requestId)`. The canonical
tuple key supplies unambiguous scope; the digest avoids directly placing account identifiers into
public views. This is opaque addressing, not a secret or an authorization check. Prefixes remain
recognizable; callers must use returned IDs. Existing saved records and references are not renamed.
Already overwritten historical records cannot be reconstructed by this change.

Each creation path also rejects a collision with a surviving object before mutation. Receipt
retention is bounded: after a receipt has gone, a repeated request must not reset completed work or
overwrite an existing booking/payment/lock intent. Tests restore domain state into a fresh host
without its old receipts and verify rejection with unchanged state. Retained receipts still replay.

## Library effect and limits

The existing command primitive was correct and sufficient; this wave repairs its consumers and
adds realistic coverage rather than introducing a new public API. Schemas, role checking,
projections, token lifecycle, serving nodes and typed clients all reuse the existing resources.

This is a workflow prototype without real payments, dispute resolution, notifications or identity
onboarding. All mutations validate first because the scaffold does not roll back arbitrary partial
business changes. Read scaling does not increase the single authority's write capacity. Persistent
state provisioning and authority failure recovery remain separate work.

Verification: full build, focused rental identity regression, pizzeria/apartments account-ID and
receipt-loss regressions, original rental/pizzeria source checks, and all six installed examples
passed. Small-jobs additionally passed its standalone resource check, strict typecheck and finite
walkthrough from the installed tarball. The first installed check exposed a repository-relative
tsx executable path; the launcher now resolves `--import tsx` from the copied project's directory.
Only small-jobs was rerun after its final launcher/resource fixes; the five unaffected installed
examples had already passed. No library implementation or public signature changed in this wave.
