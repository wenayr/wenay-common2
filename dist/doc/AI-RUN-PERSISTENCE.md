# AI run checkpoints and recovery (2.20.0)

Public imports: `createAiRunHost`, `AiRunCheckpoint`, `AiRunPersistencePort` and
`AiRunRecoveryRecord` from `wenay-common2/ai` (also the root `Ai` namespace).
Existing in-memory calls and synchronous command return types are preserved.
Without `initial` or `persistence`, legacy first-request-wins receipts remain unchanged,
including retries with a changed payload. Checkpoint mode adds the stricter input check.

## Durable boundary

Pass `{initial, persistence: {commit(checkpoint)}}` to `createAiRunHost`. The optional
port is **synchronous**: returning `undefined` acknowledges an atomic durable write;
throwing refuses it. Async functions do not satisfy the type and a runtime thenable
faults the host before runner entry. Use a synchronous local journal for this port;
an async database needs a separately designed async admission boundary, not a
fire-and-forget implementation of `commit`.

The versioned checkpoint contains Store state, original requests and private supplied
input values. The request index is rebuilt from the owner/requestId tuple. Reusing that
tuple with a different kind, input or ordered resourceIds rejects. Default generated
IDs skip all restored run/approval/input/artifact IDs. Invalid or incomplete checkpoint
relationships reject startup instead of silently discarding receipts.

The host commits queued intent and then running state **before calling the runner**.
It commits approval/input creation, answers, cancellation, progress/artifacts and the
final result before their semantic events or waiter resolution. Persistent client
projections refresh after successful checkpoints. Streaming text/tool notices are
ephemeral; use the result for durable output. The server-only `store` is live working
state, not a transaction API; never mutate it to manufacture recovery.

On a write failure the host restores its last acknowledged state, marks remaining
active runs as requiring recovery, refuses further commands/provider reports and
rejects owned waiters. The original error is available through
`host.persistence.errors` and `host.persistence.error()`. Reopen from the adapter's
actual durable state: an exception can mean the write succeeded but acknowledgement
was lost. `host.persistence.snapshot()` is an isolated coherent checkpoint, not proof
that an arbitrary external copy was committed.

One owner must write an archive at a time. The adapter owns atomicity, crash recovery,
flush policy, serialization and retention. This contract supplies no distributed lock,
multi-writer lease or exactly-once provider effect. Even a successful local write cannot
remove the interval between a provider effect and the recorded result. The application
must use provider idempotency or query its stable operation ID before repeating work.

## Restored work

Completed, failed and cancelled runs retain their receipts and results. Every restored
nonterminal run retains its old state plus `run.recovery = {from: previousState}`.
Its old callbacks and promises no longer exist; **nothing runs automatically**, including
queued work. The UI should display this recovery fact instead of an endlessly active spinner.

Server-only `host.recovery` supplies:

- `pending()`: private request, run and related approval/input records, including supplied values.
- `resume(runId)`: explicitly calls optional `runner.recover({...normalContext, checkpoint})`.
  It never falls back to `runner.run`. The recovery adapter first reconciles its provider,
  then resumes the remaining work or returns the reconciled result.
- `settle(runId, {state:'completed', output})` or `{state:'failed', error}`: records a result
  already reconciled outside the runner. Outstanding waits become cancelled.

Recovery rechecks the owner's current write/create policy, including the original
resourceIds. Policies must consult current access facts; a checkpoint does not grant
access. Ordinary cancellation is also available while recovery is required. Late results
from an old/closed/cancelled host cannot update the new host.

Pending approvals/input metadata survive. An owner can answer them before or during
explicit recovery; the answer is committed first. In `runner.recover`, pass the saved
`id` to `requestApproval({id, kind, label, data?})` or `waitForInput({id, label, schema?})`.
The host validates that ID and request belong to this run, then returns the retained
answer or creates one new waiter for that same record. A cancelled record rejects.
Do not call `run()` from `recover()` unless the provider's own idempotency contract
explicitly makes replay safe. Quotas, provider lookup, deadlines and workflow policy
remain in the application.

Only `connection(verifiedAccount).fragment` belongs on RPC. Checkpoints, persistence and
recovery are server administration surfaces and include private inputs. Closing a
connection revokes its saved command functions; bind it to the existing auth/session
scope and discard it on revoke. Closing a host cuts callbacks and asks the provider to
cancel; it deliberately leaves the last durable state available for recovery.

## Copyable example and verification

`examples/ai-support/persistence.ts` composes the port with public
`openFsReplayStorage` from `wenay-common2/server/fs`. Its private archive uses the
adapter's codec option with Node V8 serialization, retaining undefined and rich Store
values, and calls `fsyncSync` before acknowledgement. It blocks the event loop during
local writes and stores full checkpoints; choose retention/capacity and compatible
runtime versions for your deployment. It is a single-writer reference, not a database.

Run `npm run example:persistence` in the installed example. It verifies an interrupted
append, reopened archive, retained approval and final receipt using a local provider.
`oracle/regression/ai-run-persistence.spec.ts` covers failures at queued/running/result
commits, uncertain acknowledgements, owner isolation, changed input, permissions and
waiter recovery. `ai-run-archive.spec.ts` terminates an owned child after its external
file effect but before result commitment, then verifies recovery in a new process.
Existing `replay/ai-run*.test.ts` continue to exercise the in-memory/RPC contract.
No paid model call is needed.
