# Startup migration ownership

2026-09-07. A failing-first async_hooks check observed one retained Timeout after an older
archive refused startup because migrate was missing. createServiceLeader had already allocated
an authority, whose directory starts an unreferenced interval, then threw without closing it.
Process exit alone would miss this leak because that interval does not keep Node alive.

The scaffold migration block now closes its allocated authority on failure and rethrows the
original error. It reuses the existing close path and changes no public interface. The shared
template correction is generated into its copyable consumers.

The rental migration-check uses the existing ReplayStorage port and service facade. It tracks
Timeout creation/destruction via Node async_hooks without inspecting authority internals. Both
missing and throwing migration paths release the observed resources. A callback that mutates its
input snapshot then throws does not change restored business data. A corrected startup migrates
version 1 to 2 once; reopening that archive does not repeat migration. An independent reviewer
confirmed zero retained intervals for both failure cases in an isolated instrumentation probe.

This is resource cleanup, not transactional migration. After the callback returns, applying its
result or a later log callback can still fail after state changes; close may flush those changes.
The check does not simulate storage commit failure or prove rollback, and startup failures outside
the migration block remain outside this fix. See the canonical DYNAMIC-RUNTIME migration boundary.

Follow-up: MIGRATION-PREPARATION-FINDINGS.md fixes unreadable returned results before state
application by reusing the Store clone. Storage-commit and post-application failure limits remain.

Verification: full build, installed rental strict types and all resource/durable/business checks,
all 42 scaffold self-checks, generated-source consistency and scoped whitespace review passed.
