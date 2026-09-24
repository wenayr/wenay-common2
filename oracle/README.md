# Oracles — executable checks run by `scripts/run-oracles.mjs`

`npm run test:all` and `npm run release:verify` run every oracle in `oracle/`, `oracle/regression/`,
`oracle/realsocket/`, `observe/` and `replay/` (see the groups in `scripts/run-oracles.mjs`). None of
these folders ships in the npm package.

- One script per behavior; `npx tsx <file>` runs it. It prints `PASS`/`FAIL` lines and exits non-zero
  on any failure. `oracle/regression/` holds the proof for a fixed defect: the spec failed before the
  fix. `oracle/realsocket/` uses real sockets on `127.0.0.1` port 0.
- **An async oracle ends through `runOracle(main)`** from `oracle/run-oracle.ts`. An awaited promise
  that never settles lets the event loop empty, and Node exits 0: the runner would report a stalled
  oracle as green while its later checks never ran (`replay/replicated-map.test.ts` hid ten failing
  checks that way). `runOracle` makes an unsettled or thrown `main()` exit 1 and keeps an explicit
  `process.exit(code)`. Files that use `node:test` report through that runner instead.
- Under tsx an `import * as ns` object is a getter-only view: replacing `ns.fn` in a test is silently
  ignored, so a spy installed that way counts nothing. Count through a real seam (a hook, a probe
  argument, a call-site marker) and pair a count with a negative control.
- A measured bound (time, work, memory) needs a wide margin so it cannot flake on a slow CI machine;
  prefer counting operations over wall time.
