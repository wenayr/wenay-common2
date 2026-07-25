# Code style (author preferences)

Write new code in this style by default — no need to ask.

## Prohibited
- Never write new logic without first checking if it already exists in the codebase
- Never change public interfaces without explicit discussion

## Architecture
- **Closure factories instead of classes.** `function createX(deps) { ... return { ... } }`.
  Keep state in the closure; avoid classes and `this`.
- **DI at the boundary, closures inside.** A *reusable / exported* factory takes its
  dependencies as an explicit `deps` object, so it can move to its own file unchanged.
  *Inside* a factory, nesting is normal and encouraged — inner factories and helper
  functions freely close over the enclosing scope (that captured state is the whole point
  of closures). Factories don't have to be flat.
- A factory's returned object is a namespace of functions (functional style,
  an "object with meaning"). Split the return **by audience** when there's more than one —
  `control` (what goes *into* the owning unit) vs `api` (what's exposed *outward*). The
  number of facades follows the need: **one** flat object when there's a single audience,
  **two** (`control`/`api`) for the common in/out split, **more** when distinct consumers
  warrant it (e.g. `control` / `api` / `debug`). Don't force two if one is clearer.
- **Layering — separate resource / utility / business logic.** Keep the *resource* part
  (sockets, adapters, connections, stores) apart from *utilities* (pure, reusable helpers)
  and from *business logic*. Business logic is **local**: each layer has its own — the
  API-description layer carries the business rules for that API; a higher layer carries the
  business rules of *using* those APIs. Wherever it lives, mark it clearly (section dividers).
  Utility-leaning functions are better *extracted* (own function / file) so they don't blur
  into business logic.
- **Multi-level facades are fine** — `listen` (or other callbacks) may be installed at
  any nesting depth. Closures are fine. Inner factories and captured state are encouraged.
- **Expose callbacks outward.** `listen` streams that callers will subscribe to belong in
  the `api` surface — prefer over-exposing event streams to hiding them.
- Registries/tables — `as const` + inferred literal types (type-safe).

## Syntax
- **`==` / `!=`**, not `===` / `!==` (unless strict comparison is genuinely needed).
- **Don't annotate function return types** (`: Promise<void>`, `: number`, etc.) — let them
  be inferred. Exception: when the type genuinely helps the reader or narrows inference.
- Single quotes, 4-space indent, no semicolons.
- **Named functions over anonymous arrows for anything non-trivial.** A named `function foo()`
  shows up by name in stack traces / logs; an anonymous arrow is `<anonymous>`. So: real logic,
  anything that can throw, async handlers, event callbacks → name them. Trivial one-liners where
  an error is impossible (simple getters, mappers, predicates) — arrow is fine, no need to fuss.

## Types
- Union and primitive aliases — `t` prefix: `tNum`, `tSide`, `tOrderId`.
- Generic parameters — uppercase `T`, `K`, `Cb`.
- Derive public types from the implementation: `type X = ReturnType<typeof createX>`.

## Comments
- Section dividers like `// ===...===` with a block heading.
- Explain "why", not "what". Keep them short.

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

- `lib/**/*.d.ts` files are generated artifacts. Never edit them by hand.
- For a compact public-surface overview, read the relevant generated entrypoint declaration
  (`lib/index.d.ts`, `lib/server.d.ts`, or the matching exported namespace) before traversing
  implementation files.
- Run `npm run types:generate` after changing exported types. Use `npm run types:watch` while
  iterating on public type surfaces; a full `npm run build` also regenerates declarations and removes
  stale build artifacts.

## Documentation and release notes

- `README.md` is navigation only. Do not put API guides, examples, or long explanations there.
- The brief public surface lives in `doc/wenay-common2.md`.
- The extended/rare public surface lives in `doc/wenay-common2-rare.md`.
- Naming migrations live in `doc/NAMING_RENAMES.md`.
- Recent changes live in `doc/changes/` as one markdown file per published version, named `<version>.md`.
- Every release/change intended for publication must add or update the current version file in `doc/changes/` with a short commit-style summary of what changed.
- Keep only the latest 10 version files in `doc/changes/`; delete older version files when adding a new one.
- Do not publish until brief docs, rare docs, and the current version change file match the code being published.
