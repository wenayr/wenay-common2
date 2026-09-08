# SaaS waves

User direction: realistic, small products that expose missing library capabilities. Simple install,
explicit configuration, observable failures and production growth matter more than example count.
Continue autonomously from the next actionable wave. A blocked public API decision does not block
independent work in another wave. Do not change public contracts without concrete discussion.

## Queue

1. **Automated hosting — completed first slice.** Local process PaaS: deploy a bundled app, obtain a stable URL,
   prepare an update, keep existing requests alive, reject unhealthy releases and roll back.
   Reuse Contract runtime and explicit host adapters. No pretend cloud deployment or arbitrary
   untrusted-code sandbox. `examples/hosting` passed installed strict typecheck and checks, including
   close during preparation. Runtime candidate failure during readiness fixed. See HOSTING-FINDINGS.md.
   Final gate: build, npm test, 167/167 oracles and all five installed examples passed (hosting
   rerun separately after its optional IPC typing fix).
2. **Small jobs marketplace — completed first slice.** Customer posts a job, worker claims it, completion and
   acceptance; competing claims, idempotent effects, role-specific views, persistence/restart.
   Reuse existing command, access, payment/effects and Scale resources instead of another engine.
   Concrete seed: accounts/jobs/proposals; post/propose/assign/submit/accept/cancel; synchronous
   validation before mutations, public board without contacts/results, customer and worker views.
   Use existing `Command.commandReceiptKey(account, requestId)` for globally stored object IDs.
   Account collisions reproduced and fixed in rental, pizzeria and apartments: hash the canonical
   scoped key for public IDs and refuse overwrite of surviving objects after receipt eviction.
   Existing saved IDs stay intact. See SMALL-JOBS-FINDINGS.md. Source/facade regressions, full build
   and all six installed examples pass; small-jobs rerun after portable launcher and stand fixes.
3. **Easy AI service deployment — completed first slice.** A concrete document processing or support workflow:
   start locally, configure a provider, submit a task, see progress, cancel, isolate tenants,
   recover from provider failure. Demo provider must be labelled and real-provider credentials
   explicit. Start with existing AI/FileJob/Conversation resources, not a new agent framework.
   Next seed: support assistant takes a pasted ticket and returns summary/category/draft, never
   sends replies. Reuse AiRunHost/client and one runner adapter; label local deterministic provider
   clearly. Real provider is optional server configuration, validated against official docs at work time.
   Fixed synchronous runner.cancel throwing during host.close and ambiguous request identity using
   the existing scoped key; both failed-first regressions pass. Installed ai-support validates progress,
   cancellation, provider failure recovery, account isolation and original Store live-host reconnect.
   Browser journey passed. No job recovery after process restart: current hosts have no durable
   running-task recovery port. See AI-SUPPORT-FINDINGS.md. Real provider integration is still deferred.
4. **Apartments with locks — completed lifecycle slice.** Device disconnection, command expiry,
   ambiguous acknowledgements, owner permissions and safe rejoin after restart. Preserve distinction
   between a software acknowledgement and a physically verified lock action.
   Reproduced seed: restored paid booking ended yesterday + pending unlock remains in `myLock.commands`
   even though `codes` is empty. `unlock` checks dates only at enqueue, `myLock` publishes all pending,
   and device execution has no expiry guard. First regression: reconnect a real device to that archive,
   assert expired command is never executed or logged as done. Fixed shared 60-second/checkout policy,
   legacy deadlines, local motor/keypad checks and ambiguous report re-execution. Device shutdown
   settles timers and fences late readiness. Installed strict checks plus existing archive journey pass.
   See APARTMENT-LOCK-FINDINGS.md. No library interface changed; physical actuator durability deferred.
5. **Cross-product operations — completed restart slice.** Repeat installation/deployment and load patterns across
   completed products; identify the smallest reusable public seams for a separate API discussion.
   First bounded seed: compare apartments restartLeader lifecycle with verified small-jobs stand.
   Apartments lacks single-flight restart and post-stop closing checks. Reproduce concurrent restart
   and close before changing it; reuse existing process lifecycle patterns and verify installed startup.
   Completed: duplicate restart reproduced in apartments and rental; late apartment child after close
   reproduced. Both now share restart/stop operations, guard creation and await owned processes.
   Full build and installed apartments/rental checks passed, including actual node/device PIDs gone
   and HTTP working after restart. See STAND-OPERATIONS-FINDINGS.md. Library surface unchanged.
6. **Document processing service — completed first slice.** Extend the AI-product direction with uploaded plain-text
   documents: upload → processing job → downloadable result, progress/cancel and separate accounts.
   Start from existing Resource FileJob host/client and byte-storage ports, not a new queue. Keep
   deterministic extraction labelled; any real-model adapter must use explicit server configuration.
   Verify failed upload admission, failed runner, cancellation, file ownership and resource cleanup.
   The suspected beginUpload failure leaving metadata was disproved: throw/rejection precedes Store
   insertion. Do not re-fix correct code. Running-task recovery is not provided by current host ports.
   Completed copyable document-processing with bounded owner-checked UTF-8 byte storage, FileJob
   processor and authenticated result download. Fixed confirmed concurrent confirmUpload race inside
   library with one per-file verification; public declaration unchanged. Build, npm test,169 oracles,
   installed consumer and browser journey pass. See DOCUMENT-PROCESSING-FINDINGS.md.
7. **Production API review — completed.** Consolidate findings from completed products into a short,
   concrete proposal for the smallest library extensions, with before/after consumer sketches.
   Prioritize uncertain-operation identity for FileJob, durable task ownership/recovery and bounded
   retention, then compare shared process composition against existing resources. Separate already
   solved composition from missing primitives. Read declarations and canonical architecture pages
   for each proposed seam; do not implement public changes before explicit discussion. Produce a
   reviewable recommendation, not another unverified wrapper or new product just to increase count.
   Produced COMMON-LAUNCH-PATH.md with local/server/multi-process acceptance and
   PRODUCTION-API-PROPOSAL.md with additive FileJob request identity, recovery and retention decisions.
   Public interfaces remain unchanged; proposals require discussion before implementation.
8. **Common local host resource — completed.** Extract the existing HTTP/Socket.IO transport lifecycle into
   a private scaffold resource shared by rental and document-processing. Follow COMMON-LAUNCH-PATH.md.
   Keep product construction, authorization, route mounting and process signals with their owners.
   Verify the resource independently: occupied port, failed startup cleanup, repeated close, bounded
   connection shutdown and port reuse. Verify both consumers from installed package copies.
   Do not add library exports or imply durable FileJob execution from shared transport alone.
   Shared resource and consumers implemented; independent lifecycle tests, full build and both
   installed strict consumer checks pass. Rental import is inert and shutdown awaits transport.
   See COMMON-HOST-FINDINGS.md; product mount exception cleanup was reviewed, not fault-injected.
9. **Connected-client graceful shutdown — completed.** Reproduce the existing FileJob logical-line-ended
   failure in a child process with a live client during host shutdown. COMMON-HOST-FINDINGS.md records
   the observed error and test boundary. Evaluate consumer transport/product shutdown ordering;
   preserve cancellation, bounded HTTP drain and correct reconnect semantics. Do not suppress errors
   or add a FileJobClient error API without discussion. Verify from installed document-processing.
   Child regression reproduced original and transport-first-only crashes. Explicit namespace disconnect
   before replay cleanup fixes the consumer; active work cancels and ports are reusable. No core changes.
   Full build and installed document consumer checks pass, including the independent transport check.
   See DOCUMENT-GRACEFUL-CLOSE-FINDINGS.md for fresh-session versus same-live-host reconnect semantics.
10. **Rental durable single-server startup — completed.** Wire existing data/control archive resources
    into rental's entrypoint and verify restart plus backup/restore through installed consumers.
    Preserve receipts and business-state consistency; do not imply durable FileJob execution.
    SERVICE_DATA_DIR now connects both archives. Stable secrets are required and preserved by the
    launcher; incomplete pairs refuse startup. Process kill/restart and stopped-copy restoration
    distinguish original receipt replies from current cancelled business state. See RENTAL-DURABLE-FINDINGS.md.
    Full build and installed strict types, durable/backup, stand and business checks passed.
11. **Rental bounded scaling baseline — completed.** Measure one repeatable local read workload against
    the existing authority and one/two readers: fixed request counts/concurrency, startup time,
    throughput and p95, plus a reader restart. Reuse current stand/client lifecycle. Record machine
    and workload, errors and observed distribution; do not equate reader count with write scaling
    or claim production capacity from a local sample. Keep measurements separate from correctness gates.
    Installed benchmark recorded 5,400 successful snapshot reads across nine trials with exact endpoint
    distribution and reader restart-to-data timings. Short 49–66 ms samples show no established speedup;
    see RENTAL-READ-BASELINE.md and raw JSON. Full installed correctness checks also passed.
12. **Dynamic resource API feasibility — completed local slice.** Follow the user's explicit request to consider resource
    cost carefully. Compare shared type handlers plus entity IDs with per-object facade construction
    at 100/1,000/10,000 objects. Map existing contracts first; keep any probe private and do not add
    public methods, dynamic code execution or routes per object without a concrete API discussion.
    Measure creation, retained memory, invocation and cleanup with active subscribers as a separate
    dimension. Record tradeoffs and a minimal proposal; distinguish measured evidence from estimates.
    Installed private probe ran 36 fresh GC-enabled children with equivalent ACL/copy semantics.
    At 10,000 entities eager facades retained ~14.5 MiB more than shared addressing; active streams
    were lazy in both. See DYNAMIC-ENTITY-API-FEASIBILITY.md and raw JSON for noise and scope.
    Build, installed types and resource/business correctness passed; no public API changes.
13. **Dynamic entity transport cost — completed HTTP slice.** Extend the private feasibility evidence to a real
    transport: shared fixed addressing versus bounded per-entity facade/schema setup, using existing
    adapters. Read canonical RPC-AUTH before mounting; retain equivalent owner checks and business
    behavior. Measure registration, request cost and teardown independently at bounded entity counts.
    Do not confuse local closure timings with network cost, add public APIs, or introduce runtime
    code loading. Use the result to refine the concrete public proposal for discussion.
    Installed probe completed 18 fresh processes and 3,600 validated HTTP reads. At 10,000 entities
    per-object routes retained ~29.2 MiB versus ~30 KiB registration delta for a fixed handler;
    request timings are noisy. Deletion rejects reads but does not unregister routes. See
    DYNAMIC-ENTITY-HTTP-COST.md. No public changes; RPC/OpenAPI costs not measured.
14. **Dynamic entity API decision proposal — completed.** Consolidate local/HTTP evidence into a small
    user-reviewable contract proposal for shared addressing and optional lazy client handles.
    Map existing apartment commands, ownership, deletion/recreation and subscription lifecycle;
    distinguish new instances from runtime-defined types. Identify which parts need no library
    changes and which exact public seam needs discussion. Do not implement the proposed public API.
    DYNAMIC-ENTITY-API-PROPOSAL.md maps existing addApartment/book/booking operations and scoped
    views, separates runtime types from instances, and proposes optional lazy client addressing.
    Public handle/binder and deletion/generation decisions remain unimplemented for discussion.
15. **Apartment dynamic instance journey — completed.** Check existing tests first, then demonstrate
    post-start addApartment through current commands and scoped views, booking the new ID and
    isolating another host/device without transport restart. Reuse existing client/resources;
    extend only missing acceptance checks. Preserve payment/lock rules, do not add delete or
    public at()/binder APIs. Verify the installed apartment example and record actual gaps.
    Expanded existing journey to 38 checks with live addApartment, booking/payment/code, two devices
    and unchanged process inventory. Added separate two-host fixture projection checks. Existing
    production behavior was correct; no new API or library bug fix needed. See APARTMENT-DYNAMIC-INSTANCE-FINDINGS.md.
    Full build and installed strict types plus all apartment checks passed.
16. **Created apartment recovery — completed.** Extend the existing journey only where missing to restore
    the post-start apartment/device account and original creation receipt after another authority
    restart. Keep readers/devices attached and verify renewed commands/scoped data through existing
    facades. No public role assignment, deletion or handle API. Check the installed consumer.
    Journey now has 44 checks: another authority restart restores runtime-added device credentials,
    creation/booking receipts and paid state/code; retained reader/device execute a fresh intent.
    See CREATED-APARTMENT-RECOVERY.md. No production implementation change required.
    Full build and all installed apartment checks passed, including strict types.
17. **AI support shared startup lifecycle — completed.** Review the AI support host against the verified
    shared HTTP resource and document shutdown findings. Reproduce any live-client startup/close
    defect before fixing it; reuse private transport if it reduces duplicated ownership. Preserve
    provider cancellation, account isolation and explicit deterministic-provider labelling. Verify
    installed AI support; do not add public API or provider credentials.
    Reproduced live-client replay shutdown failure; reused private HTTP transport with explicit
    namespace disconnect before replay cleanup. Source and installed checks plus build passed.
    See AI-SUPPORT-HOST-FINDINGS.md. No public interface changed.
18. **Runtime-defined resource schema assessment — completed.** Map existing schema, validation and
    transport capabilities before proposing dynamic resource types. Separate generated commands
    from arbitrary code execution; identify versioning, permissions and multi-host propagation.
    Produce a bounded proposal with reuse points and missing contracts, without changing public API.
    RUNTIME-RESOURCE-SCHEMA-ASSESSMENT.md maps the private input-schema DSL, fixed HTTP/OpenAPI,
    Command receipts, Scale ownership and Contract boundaries. Missing schema admission,
    immutable revisions and migration policy are explicit. Docs-only; no runtime API added.
19. **Existing input-schema consistency — completed.** Check existing primitive and installed coverage
    before adding tests. Characterize date-string calendar validity and nested unknown-field
    rejection through the existing scaffold command corridor. Reproduce any mismatch between
    documentation and actual acceptance before fixing it; preserve pre-effect validation and
    verify an installed consumer. Do not introduce uploaded schemas or a new public DSL.
    Reproduced acceptance of impossible 2026-02-29 and corrected private calendar validation.
    New rental check proves nested/array paths, no domain effects on refusal and corrected retry.
    Full build, installed rental and all 42 scaffold checks passed. See INPUT-SCHEMA-CALENDAR-FINDINGS.md.
20. **Scaffold startup migration lifecycle — completed.** Review existing version/migrate coverage and
    resource ownership when restoring an older archive. Reproduce migration failure behavior,
    verify successful retry and cleanup, and fix only demonstrated defects. Keep startup migration
    distinct from live schema activation; preserve public interfaces and verify installed consumption.
    Reproduced retained directory timer on migration refusal; closes allocated authority while
    preserving the startup error. Missing/throwing callbacks and corrected retry verified through
    installed rental; full build and all 42 scaffold checks passed. See STARTUP-MIGRATION-FINDINGS.md.
21. **Migration result preparation — completed.** Inspect existing state-cloning/preparation resources
    before adding logic. Reproduce whether a malformed or throwing migration result can partially
    change an archive during startup. Bound any fix to preparation before state application;
    do not invent transactional storage guarantees or new public migration APIs. Verify installed
    consumption and record separately the remaining storage-commit and post-commit failure limits.
    Reproduced archive deletion before a returned getter threw. Reused cloneStoreValue to prepare
    the result before application; verified callback ownership isolation and corrected retry.
    Full build, installed rental and all 42 scaffold checks passed. See MIGRATION-PREPARATION-FINDINGS.md.
22. **Hosting overlapping updates — completed.** Review current process/Contract coverage, then exercise
    two overlapping deployment requests against the existing hosting facade and live gateway.
    Verify a coherent final binding, failure isolation and retirement of unused children. Reuse
    existing lifecycle primitives; fix only reproduced defects without new public interfaces.
    Run the installed hosting consumer and document actual concurrency semantics and limits.
    Reproduced false rejection of the first healthy concurrent deployment. Reused createAsyncQueue
    per site for deploy/rollback; verified failure recovery and queued shutdown. Source, full build
    and installed hosting passed. See HOSTING-OVERLAP-FINDINGS.md; no public library API changed.
23. **Hosting active process failure — completed.** Check existing failure coverage before extending
    the hosting journey. Terminate only an owned fixture child and verify gateway recovery through
    existing Contract failure handling, isolation of another site and cleanup. Record the actual
    fallback/retry behavior, fix only reproduced defects, and verify the installed hosting example.
    Owned v2 child termination verifies in-flight 503, v1 fallback history, automatic v2 retry,
    unchanged neighboring PID and final child cleanup. Existing implementation passed source
    and installed checks plus build. See HOSTING-ACTIVE-FAILURE-FINDINGS.md.
24. **SaaS production readiness checkpoint — completed.** Consolidate the verified waves into a small
    evidence matrix: actual core fixes, scaffold/example fixes, reused mechanisms, measured costs
    and remaining production gaps. Check findings against current code and distinguish tests from
    capacity claims. Prioritize the next bounded product wave and explicit public API decisions;
    do not add a speculative abstraction or claim deployments that were never performed.
    SAAS-READINESS-CHECKPOINT.md separates core fixes from shared scaffold gains, records six
    product boundaries and measured scaling limits, and prioritizes FileJob identity, durable
    ownership and runtime-schema decisions. Docs-only; prior checks are attributed to their waves.
25. **Sustained rental read baseline — completed.** Extend the optional benchmark using existing client
    and process resources. Compare leader/one-reader/two-reader modes under fixed total concurrency
    and payload for bounded sustained intervals with rotated trials. Report duration, errors,
    throughput, latency and generator placement; do not claim saturation or write scaling without
    evidence. Verify installed consumption and keep timing thresholds out of correctness gates.
    Added optional 1–10 second phases; nine installed 5-second trials completed 464,833 reads
    without errors. Two-reader median 12,161/s versus one-reader 9,368/s, with generator CPU near
    one core. See RENTAL-SUSTAINED-BASELINE.md and raw JSON; no saturation or write-scaling claim.
26. **Rental independent load generators — completed.** Reuse the benchmark's client/workload with
    bounded separate generator processes. Preserve total concurrency and payload so the change
    isolates generator placement, compare sustained topologies, and retain installed checks.
    Record generator CPU and placement, failures and raw trials; do not assume the servers are
    saturated or claim multi-machine results from a local process experiment.
    Shared benchmark client/measurement helper, matched two-connection/eight-lane comparison and
    bounded worker cleanup verified. Final 18 installed phases completed 853,294 reads, zero errors;
    two-reader median improved 11,104 to 13,605/s with two generators. See RENTAL-GENERATOR-BASELINE.md.
27. **AI support concurrent task isolation — completed.** Inspect existing AiRun tests and example
    coverage, then exercise overlapping provider runs across accounts with cancellation of one
    and failure of another. Verify remaining work completes, progress/result ownership remains
    isolated, and close releases provider work. Reuse runner/host/client contracts and fix only
    reproduced defects; verify the installed support example without new public APIs or model keys.
    Four overlapping controlled runs verify scoped progress/text/results, cancellation/failure
    isolation, late-output fencing and shutdown cancellation of two remaining runs. Existing
    implementation passed source/build/installed checks. See AI-CONCURRENT-RUN-FINDINGS.md.
28. **Document processing concurrent jobs — next.** Review existing FileJob/example coverage, then
    run overlapping jobs against confirmed immutable uploads, including separate accounts and
    cancellation/failure of one job while another finishes. Verify byte/result ownership and
    late-output behavior through existing client/resource facades. Fix only reproduced defects;
    preserve startJob identity semantics and verify the installed document-processing example.

## Finish each wave

- A copyable example has a short business entrypoint, documented install/start, and explicit cleanup.
- Verify the resource through its facade, product invariants and an installed tarball outside repo.
- Record library bugs separately from example bugs and missing API decisions. Fix reproductions.
- Record measured limits honestly; local demos are not proof of industrial deployment or capacity.
- Update this queue and durable findings; remove the temporary progress file when done.

## Autopilot

Thread heartbeat `saas` is active hourly. Next actionable wave: document processing concurrent jobs (item 28).
Continue one bounded wave per run, then advance this queue.
Report completed work, actionable blockers and meaningful failures; do not repeat unchanged status.
Publication, paid infrastructure and external deployments require their own authorization.
