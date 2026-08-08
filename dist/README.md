# wenay-common2

[![CI](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml/badge.svg)](https://github.com/wenayr/wenay-common2/actions/workflows/ci.yml)

## Quick start

```ts
// server (node + socket.io): one facade object, one authoritative store
import {createRpcServerAuto, listen, Observe} from 'wenay-common2'
const board = Observe.createStore<Record<string, {title: string, done?: boolean}>>({})
const exposed = Observe.exposeStoreReplay(board)
io.on('connection', socket => {
    const [disconnect, disconnectListen] = listen()
    socket.on('disconnect', () => disconnect())
    createRpcServerAuto({socket, socketKey: 'rpc', disconnectListen,
        object: {hello: async (name: string) => 'hi, ' + name, board: exposed.api}})
})
board.state['w1'] = {title: 'ship it'}           // every write becomes a numbered patch

// client (browser or node): typed proxy + live mirror of the same store
import {io} from 'socket.io-client'
import {createRpcClientHub, Observe} from 'wenay-common2'
const hub = createRpcClientHub(() => io('https://example.com'), r => ({api: r('rpc')}))
const {api} = await hub.setToken(null)
await api.readyStrict()
console.log(await api.func.hello('world'))       // 'hi, world'
const mirror = Observe.createStore<Record<string, any>>({})
Observe.syncStoreReplay(mirror, api.func.board.replay)   // keyframe + deltas + reconnect catch-up
```

Where it goes next: [`demo/`](demo/) is the full runnable stand (`npm run demo`), and every oracle in
[`replay/`](replay/) · [`observe/`](observe/) · [`oracle/`](oracle/) is a worked example of one subsystem.

## Documentation

- Brief API cheat sheet: [`doc/wenay-common2.md`](doc/wenay-common2.md)
- Extended API cheat sheet: [`doc/wenay-common2-rare.md`](doc/wenay-common2-rare.md)
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
