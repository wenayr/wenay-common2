# Document processing wave

The copyable product uploads UTF-8 text, confirms byte storage, starts a FileJob, reports progress
and downloads a small JSON report. Processing is deterministic counts/excerpts, explicitly no AI
model. Metadata uses the existing authenticated FileJob RPC/client; bytes use separate owner-checked
HTTP routes. Default local demo identities require no external account or key.

## Library correction

Concurrent confirmUpload calls could invoke storage twice. One success published uploaded, then a
second verification failure overwrote it with failed. The failing-first regression reproduced that
reversal. The host now shares one per-file verification after checking each caller's authorization.
It also preserves original failure fanout and close fences. Public signatures are unchanged.

The previously suspected beginUpload failure leak was not a defect: metadata is published only
after the adapter succeeds. The new byte resource reserves pending capacity and releases an unsealed
allocation on terminal confirmation failure, because those bytes belong to the adapter.

## Useful boundaries

- Storage: 64 KiB per text file, 64 files/4 MiB by default, declared-byte reservation, exact byte
  count and UTF-8 validation, immutable confirmed bytes, copied buffers and owner checks.
- Job: cooperative cancellation plus library late-result fencing; no second job framework.
- Product: a plain browser page and downloadable report, with per-account file/result access.

## Remaining production seams

Running jobs and metadata are in memory; byte persistence alone would not restore running work.
There is no startUpload/startJob request identity for automatic retry after uncertain transport loss.
Known unauthorized calls can use the RPC token-renewal path; that differs from replaying an operation
whose outcome is unknown. Inspect state before deliberately repeating the latter.

The storage budget bounds bytes and slots, not retained job metadata. No library deletion/retention
port or durable worker ownership was added. A real model adapter, production identity, tenant quotas
and output retention need explicit application resources or a separately discussed public contract.

## Verification

Resource facade tests cover owner isolation, allocation failure, reservations, invalid UTF-8/size,
immutability and close cleanup. Library regression covers concurrent success/failure and pending
confirmation across close; existing real Socket.IO FileJob behavior remains covered.
Full build, npm test and 169/169 oracles passed. Installed document-processing strict typecheck,
storage checks, real RPC/HTTP workflow and finite example passed outside the repository. The product
checks include failed runner then successful job, cancellation, sibling clients, protected downloads
and same Store reconnect. Browser smoke confirmed pasted text → ready report and account switch.
Generated FileJob host declaration hash was unchanged; generated example copies match their sources.
