# Installed-project HTTPS CLI

`wenay-common2` ships `wenay-https`, a server-side Caddy launcher for projects that need one
repeatable command to install Caddy, obtain or reuse a certificate, keep renewal active, inspect the
served certificate, and stop the owned process without deleting ACME data.

This is separate from the repository's multi-origin demo launcher in `DEMO-HTTPS.md`. The installed
CLI proxies an application that the consuming project already runs; it never starts the demo.

## Install and configure

Install `wenay-common2`, then add `wenay-https.json` at the consuming project root:

```json
{
    "identity": "example.com",
    "backend": "127.0.0.1:3000",
    "publicPort": 443,
    "challengePort": 80,
    "bind": "0.0.0.0",
    "email": "admin@example.com"
}
```

Add the generated runtime directory to the consuming project's `.gitignore`:

```gitignore
/.wenay-https/
```

The configuration file is durable project configuration and may be committed. `.wenay-https`
contains the generated Caddyfile, PID state, and logs; it is disposable runtime state. Certificates,
private keys, and the ACME account are intentionally outside the project in the user's application
data directory.

Configuration fields:

| Field | Meaning |
|---|---|
| `identity` | DNS hostname or public IP address on the certificate |
| `backend` | Existing HTTP/HTTPS application upstream; credentials, paths, queries, and fragments are rejected |
| `publicPort` | Local HTTPS listener, default `443` |
| `challengePort` | Local ACME HTTP-01 listener, default `80`; public TCP `80` must reach it |
| `bind` | Local listener address, default `0.0.0.0` |
| `email` | Optional ACME account contact |
| `certificateWaitSeconds` | Readiness timeout, default `120`, maximum `3600` |
| `caddyPath` | Optional explicit Caddy executable |

## Commands

```powershell
npm exec wenay-https -- doctor
npm exec wenay-https -- ensure
npm exec wenay-https -- status
npm exec wenay-https -- stop
```

- `doctor` validates the project configuration and checks Caddy, DNS/IP, the backend, and owned
  runtime state. It does not install or start Caddy.
- `ensure` verifies that the backend is reachable, finds or installs Caddy, validates the generated
  Caddyfile, starts an owned detached Caddy process, and waits for a trusted certificate. Repeating
  it with unchanged configuration reuses the process and stored certificate.
- `status` verifies process ownership and reads the certificate from the local TLS endpoint without
  opening private-key files.
- `stop` stops only the PID whose command line still points at this project's generated Caddyfile.
  It removes project PID state but preserves Caddy, certificates, keys, and ACME data.

All configuration values have matching command-line overrides; use `--help` for the complete list.
Use `--json` for an administrative backend or another machine-readable caller. `status` exits
non-zero when the endpoint is stopped or not owned; `doctor` exits non-zero when a check fails.

## Installation cache and renewal

The CLI first uses `caddyPath`, then `WENAY_CADDY_PATH`, then `caddy` on `PATH`. Otherwise it
downloads the pinned Caddy release for Windows, Linux, or macOS on x64/arm64, verifies the archive
against the release's official checksum file, and extracts it into a versioned per-user cache:

```text
<user-cache>/wenay-common2/tools/caddy/2.11.4/
```

Different projects therefore reuse one downloaded binary. Caddy's durable data is shared under:

```text
<user-data>/wenay-common2/caddy/
```

Caddy, not the application, decides when a managed certificate needs renewal. `ensure` never forces
an unnecessary ACME reissue. Renewal continues while Caddy is running. After a machine reboot, run
`ensure` from the application's supervised startup path, an operating-system service/task, or a
container restart policy; a process cannot renew certificates while it is stopped.

For ACME HTTP-01, public TCP `80` must reach `challengePort`. Binding local port `80` can require
elevated privileges. When a router or container maps public `80` to another local port, set
`challengePort` to that local port. Changing the public IP or DNS identity requires a certificate
for the new identity; an old certificate cannot authenticate it.

## Server API and an administrative button

Server code can use the same implementation without spawning the CLI:

```ts
import {createNodeHttpsManager} from 'wenay-common2/https'

const httpsManager = createNodeHttpsManager({
    projectRoot: process.cwd(),
    onLog: message => console.log(message),
})

// Call after the configured backend starts listening.
await httpsManager.ensure()
```

An administrative browser button must call an authenticated backend route. It must never execute a
shell command directly and must not accept `identity`, `backend`, paths, or executable names from
the browser:

```ts
app.post('/admin/https/ensure', requireAdmin, async function ensureHttps(_req, res) {
    const result = await httpsManager.ensure()
    res.json(result)
})
```

The manager serializes configuration through strict validation, but authentication, authorization,
CSRF protection, request throttling, and deployment access control remain the consuming
application's responsibility. Expose `status` freely only if its host, paths, PID, and certificate
metadata are acceptable diagnostics for that audience.
