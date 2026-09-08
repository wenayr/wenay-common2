# Scaffold calendar validation

2026-09-07. The failing-first primitive check showed `2026-02-29` was accepted as a
`date-string`. Date.parse normalized it into March, despite the field promising an ISO day.

The private scaffold validator now checks the UTC calendar round-trip after parsing. Existing
field names, errors and interfaces are retained. The generated template consumers receive the
same correction; no new public library export or runtime-schema admission feature was added.

The new rental input-schema-check verifies leap/non-leap centuries, month/day overflow, malformed
formats and a valid early four-digit year. It also verifies array error paths and nested unknown
fields. Through createServiceLeader's existing command corridor, refusals leave state unchanged
and never enter domain validation/apply. A corrected request with the same ID executes once and
then returns its receipt. Nested unknown-field handling was already correct.

This is a scaffold defect fixed once for its consumers, not a core RPC or scaling defect.
The first test fixture attempted structuredClone on a reactive state proxy; it was corrected
to compare serialized snapshots of this JSON-only fixture. A test file initially placed inside
the template also changed generated project contents; moving it to the rental example restored
the existing 14-file scaffold contract. Neither required a library change.

Verification: full build; installed rental strict types and all primitive, lifecycle, durable,
business and client-journey checks; all 42 scaffold self-checks; generated-source consistency.
The generated rental file remained identical after moving its source out of the template.

While reviewing coverage, confirmed an existing service-level archive version/migrate hook and
updated RUNTIME-RESOURCE-SCHEMA-ASSESSMENT.md to name it. It handles startup restore migration;
live per-resource schema changes and distributed migration remain separate concerns.
