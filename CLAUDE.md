# Code rules (author preferences)

Use these rules by default — no need to ask.

## Non-negotiable

- Before writing new logic, check whether it already exists in the project or its libraries.
  If it exists, use it; if it almost exists, wrap it instead of rewriting it.
- Never change a public interface without explicit discussion.

## Construction order

- First identify the corridors: the few places where important behavior will live.
- Sketch only enough horizontal layers and connections to discover the primitives. Sketches are
  disposable; their job is to expose the smallest useful building blocks, not become code.
- A significant primitive may itself unfold into another horizontal layer. Repeat until reaching
  local primitives, then build upward from the minimal set of those primitives.
- Aim for the smallest working skeleton with the right architecture. Build a resource before its
  consumer, but do not build an entire resource tier before it is needed.
- Keep horizontal layers few and explicit. Temporary entanglement is normal; persistent
  entanglement should be untangled. A phase-by-phase thickening file or logic with no layer of its
  own is an architecture smell.

## Layers and facades

- A layer is not complete until it exposes a deliberate facade.
- A facade is an addressing system, not a bag of methods. It should let a reader locate the layer
  responsible for a change without reading the whole project.
- Large or complex APIs should normally expose intentional multi-level facades. Depth follows real
  boundaries; flatten only small surfaces or nesting levels that do not represent a boundary.
- Name each facet after its consumer or what it exposes: `control` for commands inward, `resource`
  for raw IO, `events`/`on` for outward streams, `view` for synchronous reads, and names such as
  `health` or `source` for other real surfaces. Avoid a generic `api` name and names that merely
  repeat the obvious.
- One facet represents one boundary. If a consumer routinely cherry-picks unrelated fields from a
  facet, it likely mixes audiences and should be split.
- Inputs and behavior flow down through `deps`; facts flow up through events. Keep `UseListen` or
  equivalent subscription streams on the outward surface instead of hiding them.
- Retransmit whole facet blocks with spread rather than copying members field by field. A member may
  appear in multiple facets when each is a genuine surface. Prefer fixing a poor source facade over
  patching every consumer.
- A transformer is not retransmission. Raw-to-typed conversion gets its own facet; a normal layer
  should mostly relay correctly shaped facets instead of quietly converting them.

## Factories and internal structure

- Use closure factories for services, layers, and stateful orchestration:
  `function createX(deps) { ... return { ... } }`. Keep service state in closures instead of
  reaching for `class` and `this`.
- The reason is API shape, not a blanket ban on classes. A closure factory constructs its outward
  surface explicitly, keeps hidden state out of that surface, and can group a large API into logical
  multi-level facades by boundary and audience. A service class tends to flatten unrelated methods
  and state onto one instance, making those facades harder to express and navigate.
- Keep a class when class semantics are genuinely part of the model or contract: value objects,
  linked-list nodes and collections, iterators, `Error` subclasses, required framework inheritance,
  or APIs whose identity/prototype/constructor behavior matters. Do not mechanically convert these
  classes into factories.
- Do not replace an obviously class-shaped model with a factory. Conversely, do not use a class only
  as a container for service methods when an explicit closure-factory facade describes the API more
  clearly.
- Put DI at the boundary and use closures inside. A reusable/exported factory takes one explicit
  `deps` object so it can move to its own file unchanged. Nested factories and helpers may freely
  capture enclosing state.
- Keep resources (sockets, adapters, connections, stores), reusable pure utilities, and business
  logic separate. Business logic is local to its layer and marked with section dividers.
- Extract a utility only when it is abstract and reusable. A one-off private helper stays near its
  use rather than becoming a false shared abstraction.

## Types

- The thing itself is the source of its type. Derive exported factory types from implementation:
  `export type X = ReturnType<typeof createX>`. Do not handwrite a parallel interface.
- Introduce a shared contract only for a real family of similar layers, and keep it to the minimum
  common requirements. Validate implementations with `satisfies`; consumers depend on the contract,
  not on one concrete factory's `ReturnType`.
- Infer instead of redeclaring: derive fields with tools such as `Extract`, and preserve source types
  when retransmitting. Keep source inference broad enough to remain useful instead of accidentally
  narrowing it to values such as `0 | 1` or `undefined`.
- Carry a generic only where a caller specializes it or `satisfies` needs it to validate current
  data. Remove unspecialized generics.
- Prefix union and primitive aliases with `t` (`tNum`, `tSide`, `tOrderId`). Use uppercase generic
  parameters (`T`, `K`, `Cb`). Declare registries and tables `as const` and infer their literal types.

## Syntax and comments

- Use `==` / `!=`, not `===` / `!==`, unless strict comparison is genuinely needed.
- Use single quotes, four spaces, and no semicolons.
- Do not annotate function return types unless the annotation genuinely helps the reader or narrows
  inference.
- Use named functions for non-trivial logic, anything that can throw, async handlers, and event
  callbacks. Trivial getters, mappers, and predicates may be arrows.
- Use section dividers such as `// ===...===` with a heading. Comments are short and explain why,
  not what.

## Verification

- Verify each primitive and resource independently before the layers above it.
- Verify each wrapper through its own facade and contract, not through its internals.
- Verify the project as a composition of verified layers; a single top-level smoke test is not the
  only evidence.

## Work progress files

- For any task that is more than a tiny/local edit, create a temporary progress file before
  starting broad changes.
- Put progress files under `doc/progress/`. This is the working-doc area, separate from public
  API docs, roadmap docs, and release notes.
- Name them by task, for example `doc/progress/replay-route-handoff.md`.
- Keep the file short: goal, current checkpoint list, notable decisions, blockers, and verification
  already run or still needed.
- Update the progress file as checkpoints are completed, especially before switching context or
  making broad edits.
- When the task is finished, delete the progress file. Preserve only the durable outcome:
  final response, commit message, and, for publishable changes, the matching `doc/changes/<version>.md`
  entry.
- If work is paused or blocked locally, leave the progress file in place and make the next required
  action explicit. If the paused state must be committed or handed off, promote the useful part into
  a durable doc (`ROADMAP`, `RECOMMENDATIONS`, `doc/target`, or `doc/changes`) instead of relying on
  an ignored progress file.

## Generated declarations

- Use generated `.d.ts` files as the first, compact map of the public surface. Start from the
  package export being used, open its declaration entrypoint (`lib/index.d.ts`, `lib/server.d.ts`,
  or the matching namespace entrypoint), and follow its re-exports to the declaration that owns the
  symbol before traversing implementation files.
- Declarations answer what is exported and how types relate. They do not establish runtime behavior,
  lifecycle, errors, performance, or implementation ownership; confirm those in source, tests, and
  public documentation after the declaration locates the relevant layer.
- `lib/**/*.d.ts` files are generated, read-only artifacts. Never edit them by hand. If they are
  absent or stale, regenerate them from the source.
- After changing exported types, run `npm run types:generate` and inspect the generated declaration
  diff for the intended surface and for accidental exports, widening, or narrowing.
- Use `npm run types:watch` only as an explicitly started aid while iterating; never assume a watcher
  is running. A full `npm run build` regenerates declarations, removes stale artifacts, and is
  required before publishing.

## Documentation and release notes

- `README.md` is navigation only. Do not put API guides, examples, or long explanations there.
- The brief public surface lives in `doc/wenay-common2.md`.
- The extended/rare public surface lives in `doc/wenay-common2-rare.md`.
- Naming migrations live in `doc/NAMING_RENAMES.md`.
- Recent changes live in `doc/changes/` as one markdown file per published version, named `<version>.md`.
- Every release/change intended for publication must add or update the current version file in `doc/changes/` with a short commit-style summary of what changed.
- Keep only the latest 10 version files in `doc/changes/`; delete older version files when adding a new one.
- Do not publish until brief docs, rare docs, and the current version change file match the code being published.
