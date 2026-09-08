# Migration result preparation

2026-09-07. Extended the existing installed rental migration regression with a callback that
returns an object whose replacement field getter throws. Before the fix, startup deleted the
old record before reading that getter. Failure cleanup flushed the deletion to the archive;
a corrected retry found the original record missing. The failing-first assertion observed
undefined instead of the original {value: 7}.

The private scaffold now prepares migration output using its already imported cloneStoreValue
before changing archived fields. This reads the returned values and detaches them according to
existing Store value semantics. A getter failure now happens before state application; no new
clone utility, public type or migration interface was introduced.

The regression covers missing migration, a throwing callback and an unreadable returned result.
Each failure releases allocated timers and permits a corrected retry from the original data.
It also mutates the callback-owned successful result after startup and verifies that adopted
state stays unchanged, then reopens the archive and verifies migration ran only once.

This does not validate the domain shape of every possible migration result. It does not make
storage writes transactional, undo a failure during application/commit, or roll back a later
logging failure. Those limits require separate resource and policy decisions. The measured
failure was result preparation before application, and this fix addresses that boundary.

Verification: full build, all installed rental checks including strict types, all 42 scaffold
self-checks, generated-source consistency and scoped whitespace check passed.
