# Example stand operations

## Confirmed failures and fixes

Apartments and rental did not share simultaneous restart requests. Both calls could stop the same
process and create separate replacements on one port. Apartments also reproduced a late child
created after close had already collected the processes to stop.

Both now reuse the lifecycle pattern already verified in small-jobs: one replacement operation
per target, one stop operation per child, a closing guard before creation and after async waits,
and a close operation that waits for every owned child and pending replacement. The apartment
registry keeps old process entries instead of losing them while replacing the leader.

The changes are example process orchestration. No library implementation or public interface
changed. Node child-process resources remain behind the local stand facade; adding a public
process supervisor is not justified by this correction alone.

## Verification

Failing-first probes reproduced duplicate restart operations in both products and a late apartment
replacement after close. Cleanup retained process ownership even while testing the broken version.

`apartments/stand-check.ts` runs leader + reader + actual device processes, verifies one replacement,
the archived sequence result, HTTP 200 after restart, shared close, cancelled startup and all owned
PIDs gone. `rental/stand-check.ts` verifies the corresponding reader replacement and working board.
The existing business journeys remain part of each installed example's check.
Full build and both installed consumers passed strict typecheck, process lifecycle checks and
their existing business journeys. Generated copies match their source. No unrelated library tests
were rerun because this wave changed only example orchestration and documentation.

## Remaining boundaries

This is one-machine development orchestration, not host-machine failover, a rolling multi-machine
deployment or an industrial capacity measurement. Process histories remain in memory until the
stand is released. Archives are retained according to each example's existing data-directory policy.

There is repeated private orchestration across examples. A common scaffold resource could reduce
it once startup diagnostics, archive ownership and restart result contracts are aligned. No new
bag-of-methods library facade was introduced merely to hide those differences.

## Next product seed

AI document/file processing should exercise existing FileJob upload and job resources with a
copyable local workflow. An earlier suspected beginUpload admission bug was disproved: synchronous
throws and async rejections leave no file metadata. Preserve that ordering; look for actual gaps
through upload → job → result, account isolation, cancellation and restart boundaries.
