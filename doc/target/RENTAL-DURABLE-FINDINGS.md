# Rental durable single-authority startup

2026-09-07. Rental now wires SERVICE_DATA_DIR into the scaffold's existing durable and
durableControl ports. No library API was added or changed.

## Evidence

The failing-first process check showed the old entrypoint ignored SERVICE_DATA_DIR: after killing
the authority, a repeated booking returned a newly created timestamp rather than the saved reply.

The installed scenario creates a booking, cancels it and keeps a second booking active. After a
process kill following acknowledged replies, a new authority over the same directory returns the
original active booking receipt while current state stays cancelled. Repeating cancellation returns
its saved reply, and the other active booking still prevents conflicting reservations. This proves
receipt restoration separately from the domain's existing duplicate-ID guard.

After the writer exits, the check copies rental.jsonl and rental.control.jsonl into a separate
directory and repeats those assertions from the copy. A directory missing either member of the pair
refuses startup instead of silently restoring data without receipts.

## Ownership and configuration

- Both archives use existing openFsReplayStorage; construction follows template runLeaderProcess.
- Persistent startup requires explicit SERVICE_NODE_TOKEN and SERVICE_TOKEN_SECRET. The launcher
  preserves configured secrets instead of overwriting them with newly generated ones.
- With no SERVICE_DATA_DIR, the ephemeral demo remains unchanged.
- The two files must have one writer. No process lock or distributed fencing was introduced.
- A backup is a stopped pair plus securely preserved identity configuration, not a live snapshot.

Synchronous append is tested against process termination, not loss of power. The reference adapter
has no fsync guarantee and the archives are not a shared transaction. A crash between business and
receipt persistence can leave an uncertain outcome; receipt expiry and capacity limits still apply.
This is a verified single-authority building block, not a claim of complete production durability.

## Verification

Source failing-first and corrected process checks pass. Missing-secret refusal and inert import
were checked independently. Installed verification includes the new durable check, ordinary stand
restart/cleanup, configured-identity preservation, HTTP/RPC business scenarios and strict types.
Full build and all installed rental checks passed outside the repository; generated copies match
and scoped whitespace checks pass. Strict consumer checking caught an initially uncontextualized
replay tuple; the composition now uses the existing Scale.ScaleDurableLine contract for inference.
