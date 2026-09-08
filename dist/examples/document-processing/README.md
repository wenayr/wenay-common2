# Text document processing

Copy this directory, then run:

```sh
npm install
npm run typecheck
npm start
```

Open the printed local URL. Upload a plain UTF-8 document, process it, inspect progress and download
the JSON report. The local Alice/Bob accounts demonstrate separate file and job ownership.
`npm run example` runs a finite client journey; `npm run check` verifies storage and the product.
The page also accepts pasted/sample text. `PORT` sets an optional fixed port; Ctrl+C closes the host.

**Deterministic processing, no AI model.** The processor counts words/lines and takes an excerpt.
No external model, key or paid service is used. This example exercises the file/job foundation for
a document product; model integration is a separate server-side runner implementation.

## Where behavior lives

- `storage.ts`: byte admission, capacity, owner checks and immutable confirmed uploads.
- `provider.ts`: text processing through the existing `FileJobRunner` port.
- `service.ts`: FileJob composition and account-scoped product surfaces.
- `host.ts`: local page, HTTP byte/result routes and authenticated RPC.
- `http-host.ts`: shared scaffold transport ownership, startup and bounded shutdown; no package export.
- `client.ts`: existing FileJob client and transport; `page.ts`: browser controls.

The default storage accepts at most 64 KiB per file and reserves capacity when an upload begins.
It verifies the actual byte count and valid UTF-8 before confirmation. A failed confirmation releases
its byte reservation; start a new upload after that failure. Confirmed uploads cannot be overwritten.

## Boundaries

Files, jobs and results live in memory and disappear on host restart. Reconnection to a living host
can recover metadata; it is not durable job recovery or distributed scheduling. The local account
selector issues demo sessions without passwords and is not production authentication.

Graceful host shutdown explicitly disconnects RPC clients before closing replay sources and
cancels active processing. The server-issued disconnect stops automatic Socket.IO reconnection.
After starting a new in-memory host, obtain a new demo session and create a fresh client;
the previous host's token and job data are not restored. Temporary client offline/online against
the same live host retains the original client Store.

FileJob startUpload/startJob have no request identity for automatic replay after an ambiguous
network failure. Inspect state before deliberately starting another operation. Cancellation fences
late results; the application runner owns cooperative stopping and its resources.

File bytes use separate authenticated HTTP routes. Original download authorization and result
download authorization must both be enforced by the application; hiding a link is not access control.
For production, supply durable byte storage, identity, quotas and worker ownership explicitly.
