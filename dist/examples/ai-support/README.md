# Support drafting desk

Copy this directory, then run:

```sh
npm install
npm run typecheck
npm start
```

Open the printed local URL. Paste a support ticket, prepare a draft and review the summary,
category and reply. Cancel a running task, or switch between local demo accounts Alice and Bob.
Nothing is sent to customers. `PORT` optionally sets a fixed port; Ctrl+C closes the host.

**The default provider is a deterministic demo, not an AI model.** It uses keyword matching,
an excerpt and a reply template. No API key, network model call, token usage or payment is involved.
English keywords demonstrate the workflow; this is not a quality evaluation of AI answers.

`npm run example` runs a short RPC client journey and exits. `npm run check` checks account
isolation, retries, cancellation, progress and reconnection to a living host, then runs that journey.

## Where changes belong

- `provider.ts`: the runner behind the library's existing `AiRunRunner` contract.
- `service.ts`: ticket validation, capabilities and account-scoped AI fragments.
- `host.ts`: local HTTP page and authenticated HTTP/RPC adapters.
- `client.ts`: existing RPC hub and AI client, exposing a stable Store.
- `page.ts`: small browser interface, using HTTP polling without a bundler.

To connect a real model, implement the runner on the server: map progress/results, propagate
cancellation and load credentials from server configuration. Keep the UI provider label accurate.
No real-provider adapter is included in this first slice.

## Verified boundary

A controlled runner check overlaps four tasks across two accounts: cancelling one and failing
another leaves both healthy tasks running. Live output and results remain account-scoped, late
cancelled output is ignored, and host shutdown requests cancellation once for each remaining run.
This checks lifecycle isolation, not model throughput or durable task execution.

RPC reconnect preserves the original client Store while the host keeps running. Run state is in
memory: restarting the host loses tasks and retry history. Each account sees its own runs; the local
account selector deliberately issues demo sessions without passwords and is not production identity.

This is one host, not a distributed worker queue. More CPU can support additional concurrent work,
but no capacity benchmark is claimed. Multiple independent hosts would have separate runs: shared
ownership, durable scheduling, quotas and production authentication need an explicit deployment design.

## Transport lifecycle

The example shares the private `http-host.ts` scaffold resource with rental and document processing.
Shutdown explicitly disconnects clients before closing replay sources, cancels running provider work
and awaits bounded transport cleanup. A server-issued disconnect stops automatic reconnection;
after starting a new in-memory host, obtain its new demo session and create a fresh client.
`npm run check` includes an isolated live-client shutdown regression and independent transport checks.
