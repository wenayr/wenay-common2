# wenay-common2

[![CI](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml/badge.svg)](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml)

## Start here

- [Typed Store and local-to-cluster journey](doc/STORE-CONSUMER-GUIDE.md)
- [Runnable demo](demo/) and worked examples in [replay](replay/), [observe](observe/), [oracle](oracle/)
- [Comprehensive audit and next priorities](doc/COMPREHENSIVE-AUDIT.md)
- [Library usefulness and project construction for developers and AI](doc/LIBRARY-ASSESSMENT.md)
- [Authority ownership, partitions and resource fencing](doc/SCALE-SAFETY.md)

## Documentation

- Brief API cheat sheet: [`doc/wenay-common2.md`](doc/wenay-common2.md)
- Extended API cheat sheet: [`doc/wenay-common2-rare.md`](doc/wenay-common2-rare.md)
- Store ownership, type flow and local-to-cluster journey: [`doc/STORE-CONSUMER-GUIDE.md`](doc/STORE-CONSUMER-GUIDE.md)
- Runtime protocols: [`AI`](doc/AI-RUN-PROTOCOL.md) · [`Artifact`](doc/ARTIFACT-RUNTIME.md) ·
  [`Conversation`](doc/CONVERSATION-RUNTIME.md) · [`Contract`](doc/CONTRACT-RUNTIME.md) ·
  [`Dynamic modules`](doc/DYNAMIC-RUNTIME.md)
- Dynamic runtime executable evidence: [`internal vertical slice`](doc/DYNAMIC-RUNTIME-IMPLEMENTATION.md)
- Implementation prompts: [`Dynamic runtime skeleton`](doc/prompts/IMPLEMENT-DYNAMIC-RUNTIME.md),
  [`Dynamic MCP contributions`](doc/prompts/IMPLEMENT-MCP-CONTRIBUTION-GATEWAY.md),
  [`MCP architect`](doc/prompts/MCP-ARCHITECT.md),
  [`Agent HTTP control, dev hot-reload and dynamic tools`](doc/prompts/IMPLEMENT-AGENT-HTTP-CONTROL.md)
- Installed-project HTTPS CLI and renewal: [`doc/HTTPS-CLI.md`](doc/HTTPS-CLI.md)
- Public HTTPS/WSS demo stand and certificates: [`doc/DEMO-HTTPS.md`](doc/DEMO-HTTPS.md)
- Generated `.d.ts` overview workflow for TypeScript/TSX projects:
  [`doc/RECOMMENDATIONS.md#generated-declaration-overview-for-consuming-projects`](doc/RECOMMENDATIONS.md#generated-declaration-overview-for-consuming-projects)
- Project direction: [`intent`](doc/INTENT.md) · [`recommendations`](doc/RECOMMENDATIONS.md) ·
  [`conditional roadmap`](doc/ROADMAP.md)
- Naming migrations: [`doc/NAMING_RENAMES.md`](doc/NAMING_RENAMES.md)
- Recent changes: [`doc/changes/`](doc/changes/)
- Project rules for AI/code maintenance: [`CLAUDE.md`](CLAUDE.md)

## Living examples (shipped in the npm package)

- [Copyable example projects by level](examples/README.md): [rental](examples/rental/README.md) (one service, typed client, HTTP/Swagger, serving nodes), [pizzeria](examples/pizzeria/README.md) (roles, per-audience view lines, login, the role panel), [apartments](examples/apartments/README.md) (payment intents, signed webhooks, a lock device, a durable leader) — each verified outside the repository.

- [`demo/`](demo/) — runnable from a repository checkout (`npm run demo`): participant-based video rooms and
  private/group calls with speaker and grid views, an authoritative Store/replay operations board, a self-assembling replica network,
  versioned implementation update/fallback/rollback, shared cursors with relay ⇄ WebRTC direct hand-off, and Resource → AI → Artifact plus
  multi-channel Conversation examples on the same RPC connection.
- Public raw-IP/hostname HTTPS/WSS launch, certificate issuance, router forwarding, and diagnostics:
  [`doc/DEMO-HTTPS.md`](doc/DEMO-HTTPS.md).
- [`replay/`](replay/) · [`observe/`](observe/) · [`oracle/`](oracle/) — the oracle suites CI runs on
  every push; each file doubles as a worked usage example of one subsystem.
- The package ships readable example sources rather than installing the demo scripts as commands;
  `wenay-https` is the separate installed server-tool entrypoint. Examples import from the repo's
  `src/`; in application code the same API comes from
  `wenay-common2` / `wenay-common2/peer` / `wenay-common2/replay` / `wenay-common2/observe` /
  `wenay-common2/contract`; focused lower-level entrypoints are `wenay-common2/listen`,
  `wenay-common2/rpc`, `wenay-common2/server/fs`, `wenay-common2/server/auth`,
  `wenay-common2/server/http`, and `wenay-common2/server/webhook`.
