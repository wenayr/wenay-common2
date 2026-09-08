# SaaS production readiness checkpoint

2026-09-07, after wave 23. The examples have produced concrete library fixes and simpler shared
application plumbing. They have not established production capacity, complete durable execution
or a universal deployment platform. This checkpoint summarizes existing evidence; it is not a
new all-project certification run.

## Actual library gains

| Product trigger | Core correction confirmed in current source | Evidence |
| --- | --- | --- |
| Hosting candidate fails during asynchronous health evaluation | Contract observes preparation failure before activation | `src/Common/contract/contract-runtime.ts`, [hosting findings](HOSTING-FINDINGS.md) |
| AI runner cancellation throws synchronously | AiRunHost isolates cancellation failure so remaining cleanup proceeds | `src/Common/ai/ai-run-host.ts`, [AI findings](AI-SUPPORT-FINDINGS.md) |
| Distinct AI account/request pairs collide | AiRunHost reuses canonical commandReceiptKey | Same source and AI lifecycle regressions |
| Concurrent upload confirmation races success against failure | FileJob shares per-file confirmation after authorization | `src/Common/resource/file-job-host.ts`, [document findings](DOCUMENT-PROCESSING-FINDINGS.md) |
| Reader topology grows from one to two nodes | Earlier scale-client balancing correction | [growth cycle](SAAS-SCALE-GROWTH.md); this checkpoint did not rerun its benchmark or oracle |

These are changes to existing behavior, not newly added API names. Earlier wave findings record
full-suite runs when those fixes landed. The latest hosting-only acceptance does not substitute
for running all release gates again before publication.

## Shared scaffold and example gains

- One private HTTP resource serves rental, document processing and AI support, with independent
  startup/shutdown checks. Explicit Socket.IO disconnect ordering prevents replay cleanup errors.
- Rental and apartment launchers now handle repeated restart and close races. Rental preserves
  configured identity secrets and can restore business and control archives after process restart.
- Scoped command receipt keys prevent cross-account public object-ID collisions in examples;
  retained records are protected even when their older receipts are no longer available.
- Apartment commands and devices enforce expiry locally as well as at admission. Dynamically
  added apartment/device identities survive the tested authority restart workflow.
- The shared input validator rejects impossible calendar days before business effects.
- Startup migration releases resources on failure and prepares a detached result before changing
  archived records. These fixes do not create a storage transaction.
- Hosting reuses createAsyncQueue to order whole deploy/rollback intents per site. Contract still
  owns binding selection, health evaluation, lease retirement and process-failure recovery.

No separate server or route registry was needed for each new business object. No generic workflow
engine or second deployment runtime was added. Private resources should remain private until
there is evidence that a specific package contract helps multiple independent consumers.

## Product evidence and production gaps

| Product | Verified behavior | Important remaining boundary |
| --- | --- | --- |
| Hosting | Installed startup, overlapping updates, health rejection, request leases, rollback, owned-child crash/fallback/retry, neighboring process isolation | Local trusted bundles; gateway is a single failure point; no durable deployment queue, admission cap, arbitrary-code sandbox, DNS/TLS provisioning or multi-machine scheduler |
| Rental | Installed RPC/HTTP journey, reader restart, receipts, acknowledged state recovery after process kill, stopped archive-pair backup | Single writer; two archives are not atomic; no power-loss/fsync or distributed fencing guarantee |
| Apartments/locks | Installed roles/device checks, expiry, runtime-created apartment and device, payment/code workflow and authority restart | Simulated payment/actuator boundaries; no proof of durable physical action or production device identity provisioning |
| Small jobs | Installed workflow, competing assignments, scoped views, typed client and serving-node restart | No verified durable authority recovery for this product; no real payment/dispute/onboarding workflow |
| AI support | Installed progress/cancel, failure recovery, scoped request IDs, same Store reconnect and live-client shutdown | Deterministic provider; no real-model quality/cost measurement, durable task ownership or distributed workers |
| Document processing | Installed bounded byte storage, confirmation, jobs, cancellation, protected results and cleanup | Deterministic processing; in-memory tasks/metadata; uncertain startJob identity and metadata retention unresolved |

Detailed boundaries remain in each product's findings and README. Smart-home coverage is recorded
separately in SMART-HOME-FINDINGS.md; this table concentrates on the requested SaaS directions.

## Scaling: evidence versus expectation

Horizontal read topology and recovery have acceptance evidence. They do not imply horizontal write
capacity. More CPU or a larger node weight does not establish vertical scaling efficiency. The
chosen data resource must enforce ownership and commit effects safely; see [SCALE-SAFETY](../SCALE-SAFETY.md).

The [rental baseline](RENTAL-READ-BASELINE.md) completed 5,400 matching requests, but measured phases
lasted only 49–66 ms. Median rates with one/two readers were too close relative to variation to
establish speedup. The next useful measurement is sustained traffic, not another instantaneous rate.

The [HTTP route probe](DYNAMIC-ENTITY-HTTP-COST.md) found approximately 29.2 MiB retained for 10,000
per-record routes versus about 30 KiB for a shared handler. This supports fixed operations addressed
by IDs. It does not measure database capacity, runtime schema admission or distributed performance.

## Decisions that still need an explicit API discussion

1. **FileJob operation identity.** The concrete candidate is the proposed requests.startJob
   surface in [PRODUCTION-API-PROPOSAL](PRODUCTION-API-PROPOSAL.md). Decide its name, async shape,
   retention window, same-ID/different-input behavior and authorization before receipt lookup.
   Current startJob must not silently change contract. An external retry wrapper is insufficient.
2. **Durable task ownership.** Define which intent/result is committed and where the worker's
   ownership is enforced. Start with one document task and crash boundaries; do not equate saved
   bytes or a replicated Store with recoverable execution.
3. **Runtime-defined resource types.** Choose the admitted schema subset and revision policy in
   [RUNTIME-RESOURCE-SCHEMA-ASSESSMENT](RUNTIME-RESOURCE-SCHEMA-ASSESSMENT.md). Existing schema
   validation and service-level boot migration are reusable; uploaded-schema admission and live
   per-type migration are not implemented. No public at(id) helper is approved either.

Recommended order: discuss operation identity first, then durable execution/retention together on
one product. Runtime-defined types remain a separate example rather than a prerequisite for every
SaaS. Production identity, durable storage and deployment targets also need actual environment
choices; no external deployment or paid resource has been performed by these waves.

## Next independent wave and acceptance

Extend the optional rental read benchmark with a bounded sustained phase. Hold total concurrency
and payload constant across leader-only, one-reader and two-reader modes; rotate trial order and
report duration, success/error counts, achieved throughput and latency distributions. Preserve the
ordinary installed checks. Record load-generator placement and avoid interpreting a local client
bottleneck or a short sample as server capacity. Do not add timing thresholds to correctness tests.

This can proceed while public API decisions remain open. It answers the user's scaling question
with additional evidence without expanding the package speculatively.

Verification for this checkpoint: cross-checked core cancellation/identity/confirmation/preparation
code, current hosting acceptance and earlier product/measurement findings. Only working design
documents changed; no build, benchmark or installed consumer was rerun in this assessment wave.
