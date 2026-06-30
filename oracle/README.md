# oracle/ — disposable test oracles

Convention (see PLAN.md "Working agreement"):

- One file per task being verified: `oracle/<task-slug>.oracle.ts`.
- Log-based: prints `PASS`/`FAIL` lines, exits non-zero on failure.
  Run: `node node_modules/ts-node/dist/bin.js --transpile-only oracle/<name>.oracle.ts`
- **Disposable**: after the fix goes green, the oracle file is DELETED and a one-line
  mark is appended to `PASSED.md`. The completed task is then removed from PLAN.md/PLAN_ru.md
  (history lives in git).
- The only PERMANENT test in the repo is the RPC harness: `src/Common/rcp/rpc.harness.spec.ts`.
- This folder is excluded from the published build (not under `src/`).
