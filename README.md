# wenay-common2

[![CI](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml/badge.svg)](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml)

## Documentation

- Brief API cheat sheet: [`doc/wenay-common2.md`](doc/wenay-common2.md)
- Extended API cheat sheet: [`doc/wenay-common2-rare.md`](doc/wenay-common2-rare.md)
- Public raw-IP/hostname HTTPS demo and certificates: [`doc/DEMO-HTTPS.md`](doc/DEMO-HTTPS.md)
- AI run protocol: [`doc/AI-RUN-PROTOCOL.md`](doc/AI-RUN-PROTOCOL.md)
- Conversation runtime: [`doc/CONVERSATION-RUNTIME.md`](doc/CONVERSATION-RUNTIME.md)
- Versioned contract runtime: [`doc/CONTRACT-RUNTIME.md`](doc/CONTRACT-RUNTIME.md)
- Naming migrations: [`doc/NAMING_RENAMES.md`](doc/NAMING_RENAMES.md)
- Recent changes: [`doc/changes/`](doc/changes/)
- Project rules for AI/code maintenance: [`CLAUDE.md`](CLAUDE.md)

## Living examples (shipped in the npm package)

- [`demo/`](demo/) — runnable from a repository checkout (`npm run demo`): participant-based video rooms and
  private/group calls with speaker and grid views, an authoritative Store/replay operations board, a self-assembling replica network,
  versioned implementation update/fallback/rollback, shared cursors with relay ⇄ WebRTC direct hand-off, and Resource → AI → Artifact plus
  multi-channel Conversation examples on the same RPC connection.
- Public raw-IP/hostname HTTPS/WSS launch, certificate issuance, router forwarding, and diagnostics:
  [`doc/DEMO-HTTPS.md`](doc/DEMO-HTTPS.md).
- [`replay/`](replay/) · [`observe/`](observe/) · [`oracle/`](oracle/) — the oracle suites CI runs on
  every push; each file doubles as a worked usage example of one subsystem.
- The package ships readable example sources, not installed CLI scripts. Examples import from the
  repo's `src/`; in application code the same API comes from
  `wenay-common2` / `wenay-common2/peer` / `wenay-common2/replay` / `wenay-common2/observe` /
  `wenay-common2/contract`.
