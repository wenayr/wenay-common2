# Runtime-defined resource types: reuse and missing contracts

2026-09-07. Assessment only. No new public API, schema upload endpoint or implementation.

## Proposed outcome

A user defines a resource type after startup, and can immediately create and read its records
through a fixed set of authorized operations. Type definitions are versioned data. Registering
a type does not load JavaScript, create a server, or register routes for every record.

The first useful example is a configurable inventory for a hosting service: a user defines
fields for an inventory item and stores entries. Provisioning an actual site remains an explicit
domain command with its own permissions, budget, receipt and resource adapter. A field schema
cannot infer provisioning, payment cancellation or physical-lock access rules.

## Existing corridors

| Responsibility | Existing implementation | Boundary |
| --- | --- | --- |
| Command input validation | Scaffold `buildInputValidate` in `experiments/wenay-scaffold/template/input-schema.ts` | Validates records against a trusted schema, not uploaded schema definitions |
| One source for types and documentation | Same file: `InferInput`, `schemaCommand`, `inputJsonSchema` | Literal TypeScript inference is for schemas known at build time |
| Validation before business effects | `experiments/wenay-scaffold/template/leader.ts`, `domainCommands` | Builds validators at startup; roles and domain rules remain explicit |
| Command execution and retries | Public `Command.createCommandHost` | Retained receipts identify account/requestId and command, not an input hash or schema revision |
| HTTP exposure | Public `createHttpFacadeServer` | Discovers functions once, captures handlers; no unregister/replace or payload-schema validation |
| API documentation | Public `createHttpFacadeOpenApi`, scaffold `rest.ts` | `argSchemas` documents inputs; it does not install validation. Document construction is a snapshot |
| Reactive records and replication | Public Store, Replay and `Scale.createAuthority` | Replicates application state; does not invent schema migration or distributed write fencing |
| Implementation replacement | Public Contract resolver/runtime | Exact contract version by default, custom compatibility policy and leased bindings; no record-schema analysis |

Declarations were inspected from `lib/index.d.ts`, `lib/server.d.ts`, and owning declarations
under `lib/Common/{command,scale,Observe,contract}` and `lib/server/httpFacade*.d.ts` before source.

The private scaffold DSL already supports scalar fields, optionality, string enums, arrays of
scalars and recursive object fields. It rejects unknown data fields and generates corresponding
JSON Schema. It is not a general JSON Schema interpreter. Reuse it where the chosen subset fits;
do not introduce a second validator with the same responsibilities.

## Smallest architecture to evaluate

1. **Schema admission.** Validate an untrusted definition itself before it reaches the existing
   record validator. Bound definition bytes, fields, nesting and enum size; reject unsupported
   constructs and unsafe names. Capture an owned immutable definition, with tenant, type ID and
   revision. The current validator captures its schema by reference: a cast or mutable caller
   object is not an admission boundary.
2. **Versioned resource state.** Keep definitions, active revisions and records under an explicit
   authority. Each record carries the schema revision it was accepted against. Keep old definitions
   while records or requests refer to them. Do not reuse retired type IDs implicitly.
3. **Fixed operations.** Type ID and record ID are inputs to a small known command set. Existing
   command fragments and transport are built once. Each request resolves one admitted revision,
   checks ownership and validates before effects. No automatic delete, arbitrary expressions or
   uploaded callbacks in the first slice.
4. **Discovery and reads.** Return an authorized description of types, fields and permitted
   operations. A UI can render a form from that description. Already-built clients work with
   runtime-validated data; an optional generated typed client is a separate build artifact.
5. **Outward updates.** Use declared, principal-scoped Store/replay surfaces with explicit cleanup.
   Only allocate subscriptions when requested. Do not hide revocable streams in `noStrict`:
   canonical RPC authorization documents that those streams are not walked for downgrade cleanup.

These are responsibilities, not proposed package method names. A schema registry should not
become a second transport, command host, Store, deployment controller or Contract runtime.

## Schema changes and multiple servers

For a first prototype, admit version 1 only and explicitly reject redefinition of that type.
This still demonstrates creation of entirely new types at runtime. Then add a separate,
reviewable version-change scenario instead of silently mutating a live validator.

An update request should declare the revision it expects. The write authority decides admission
against current state; a reader with a stale schema must not approve a write locally. Resolve a
revision once for a request and retain that identity through asynchronous work. Requests that
cannot satisfy the selected revision fail explicitly rather than being reinterpreted.

Existing receipts intentionally return the original result for a repeated account/requestId.
Do not re-run an old successful command under a new schema; a new intent needs a new request ID.
If the product must reject same-ID/different-payload reuse, that is additional business policy,
not a guarantee of the current Command host. Receipt retention and crash windows still apply.

Replicating definitions and records does not alone prove atomic migration, crash-safe commit or
single-writer ownership under a partition. The durable resource must define their commit boundary;
the host must enforce ownership at that boundary. See [SCALE-SAFETY](../SCALE-SAFETY.md).
For an initial two-server demonstration, use one write authority and one reader. Do not describe
it as distributed schema consensus or horizontal write scaling.

Renaming/removing fields, changing constraints and changing permissions require explicit policy.
The scaffold already has a whole-service startup migration hook: definition.version and migrate
restore an older archive into the new state before serving it (template/leader.ts and self-check.ts).
Reuse that seam for service-level boot migration where appropriate. It is not live per-resource
schema activation, a distributed migration transaction or a reversible migration protocol.
Code rollback cannot restore data discarded by a migration. The existing dynamic-runtime guide
assigns migration to the host and records it as deferred; Contract activation cannot supply it.

## Resource cost: what is known

Prior [HTTP measurements](DYNAMIC-ENTITY-HTTP-COST.md) establish the avoidable cost of one route
per record: about 29.2 MiB for 10,000 routes versus about 30 KiB for a shared handler in that probe.
They do not measure runtime schema admission, validation or OpenAPI generation.

For this design, metadata and validator retention should follow admitted type revisions, while
record storage follows record count and subscriptions follow active consumers. The existing
validator walks input objects/arrays on each call; `buildInputValidate` is a closure constructor,
not evidence of a compiled validator or constant-time validation. The next benchmark should vary
type count, revisions retained, field depth and input length separately from record count.
Measure admission time/heap, validation throughput and p95, discovery size and replication lag.
Do not extrapolate the earlier route measurements into those numbers.

## Decisions before implementation or public extraction

- First schema language: reuse the existing small DSL with a bounded admission contract, or
  adopt broader JSON Schema semantics with an explicitly selected validator? Recommend the
  existing subset for a first example; it is not yet an approved public schema contract.
- First revision policy: immutable version 1 and rejection of redefinition, or immediately
  support migration? Recommend immutable version 1 to keep the first result inspectable.
- Which domain operations may be offered by the product? Generic inventory data is a suitable
  first case; automatic provisioning and other external effects remain separately implemented.

No generic helper is being exported or hidden in a wrapper pending those decisions. Meanwhile,
the existing scaffold validator can be checked for agreement between documented field semantics,
runtime acceptance and rejection before business effects, without introducing a new interface.

## Evidence and verification

- `experiments/wenay-scaffold/self-check.ts`: existing schema value/unknown-field/nesting checks.
- `type-tests/input-schema-inference.ts`: existing source-schema inference checks.
- `oracle/regression/http-facade-server.spec.ts`: existing transport/registration checks.
- `src/server/httpFacadeOpenApi.ts`: snapshot construction and descriptive `argSchemas`.
- `src/Common/command/command-host.ts`: startup command names, receipt lookup before execution.
- `src/Common/contract/contract-resolver.ts`: descriptor validation and implementation compatibility.
- `observe/contract-runtime.test.ts`: existing binding compatibility/lifecycle evidence.
- Canonical [RPC-AUTH](../RPC-AUTH.md) and [DYNAMIC-RUNTIME](../DYNAMIC-RUNTIME.md) reviewed.

This wave changes working design documents only. No new runtime behavior or installed example is
claimed; build and installed-consumer tests were not repeated. A second reader independently
checked schema and Contract reuse points. Next wave verifies existing input-validation behavior.
