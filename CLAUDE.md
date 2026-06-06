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
- A factory's returned object is a namespace of arrow functions (functional style,
  an "object with meaning"). When a factory serves two audiences, split the return by
  audience — e.g. `control` (what goes *into* the owning unit) vs `api` (what's exposed
  *outward*).
- Registries/tables — `as const` + inferred literal types (type-safe).

## Syntax
- **`==` / `!=`**, not `===` / `!==` (unless strict comparison is genuinely needed).
- **Don't annotate function return types** (`: Promise<void>`, `: number`, etc.) — let them
  be inferred. Exception: when the type genuinely helps the reader or narrows inference.
- Single quotes, 4-space indent, no semicolons.
- Arrow functions inside objects, concise.

## Types
- Union and primitive aliases — `t` prefix: `tNum`, `tSide`, `tOrderId`.
- Generic parameters — uppercase `T`, `K`, `Cb`.
- Derive public types from the implementation: `type X = ReturnType<typeof createX>`.

## Comments
- Section dividers like `// ===...===` with a block heading.
- Explain "why", not "what". Keep them short.

## Author utilities
- Frequently uses helpers from `wenay-common2` (`UseListen`, `sleepAsync`, `MyMap`, etc.).
- Full library reference — see **`wenay-common2.md`** (read it when working with RPC/utilities).