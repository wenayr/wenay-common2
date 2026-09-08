# {{name}}

Generated service using public `wenay-common2` entrypoints, version 2.16.0 or later.

Run `npm install`, `npm run typecheck`, then `npm run leader`. The leader prints its URL.
If this library version is not published yet, install the locally built tarball instead:
`npm install C:\path\to\wenay-common2-2.16.0.tgz`.

Start with `service.ts`: define state, validated commands and the read projection. Leader and node
factories provide replication and command receipts. Configure transports, secrets and deployment
through the host environment; the scaffold is an in-memory development starting point.

To add a serving node, set the same `SERVICE_NODE_TOKEN` and `SERVICE_TOKEN_SECRET` on both
processes before starting the leader. In another terminal, also set `SERVICE_UPSTREAM` to its URL,
`SERVICE_NODE_ID` to a unique node name, and run `npm run node`. `SERVICE_PORT` defaults to an
available port. Use your shell's environment-variable syntax; never commit secrets.

Nodes distribute reads and forward writes to the same authority. They do not create independent
write partitions or elect a replacement authority. State and receipts need explicit persistence
for authority restart recovery. Production identity issuance and operational policy belong to your host.

The `readerFacet` projection does not restrict the full replicated state exposed by `replica`.
Do not place private data on a publicly served replica. This template's login is a demonstration
identity adapter, not a production sign-in system.
