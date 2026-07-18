# Public HTTPS demo and certificate

This guide starts the repository demo on a non-standard public HTTPS port, obtains a browser-trusted
certificate automatically, and keeps Socket.IO/WebSocket and browser media APIs in a secure context.
The commands are for a **repository checkout**. They are not installed as CLI commands with the npm
package.

The current stand exposes the same application through two independently trusted certificates:

```text
https://77.40.53.96:3100/
https://77-40-53-96.sslip.io:3100/
```

The first URL uses a Let’s Encrypt certificate whose Subject Alternative Name is the literal public
IP. It needs no DNS name. The second is a fallback ordinary DNS-name certificate; no domain purchase
is required because sslip.io resolves the address embedded in the hostname. Port `3100` is not part
of either certificate identity, so the application does not have to run on `80` or `443`.

The raw-IP certificate uses Let’s Encrypt's `shortlived` profile and is valid for 160 hours. The
sslip.io certificate currently uses the ordinary 90-day profile. Caddy obtains and renews both; the
short lifetime does not require a manual six-day reinstall.

## Certificate choices

| Choice | Public browsers trust it? | DNS purchase | Lifetime and use |
| --- | --- | --- | --- |
| Let’s Encrypt raw-IP certificate | Yes | None | 160 hours; preferred direct URL, automatic renewal |
| Let’s Encrypt certificate for an sslip.io name | Yes | None | Ordinary DNS certificate; useful fallback |
| Self-signed certificate or mkcert/private CA | Only after installing that CA on every client | None | Good for controlled devices, not arbitrary external browsers |

The launcher configures the first two choices. Installing a private CA is intentionally not part of
this public stand: it would not make an unknown external browser trust the server.

## Network layout

Two independent TCP forwards are required:

| Internet | Router destination | Local listener | Purpose |
| --- | --- | --- | --- |
| TCP `80` | this computer, TCP `3102` | Caddy, while ACME needs it | Let’s Encrypt HTTP-01 validation and later renewal |
| TCP `3100` | this computer, TCP `3100` | Caddy → Node on `127.0.0.1:3100` | the actual HTTPS/WSS demo |

The launcher can create the first rule temporarily through NAT-PMP. It **does not create the public
`3100 → 3100` rule**; configure that rule on the router yourself. TCP is sufficient for HTTPS and
WebSocket. UDP `3100` is only useful for optional HTTP/3.

`alt_http_port 3102` in the generated Caddy configuration does not change the public ACME port.
Let’s Encrypt still connects to public TCP `80`; the router must deliver that traffic to local
`3102`. The application itself remains on `3100`.

## 1. Prepare the address and router

You need a public IPv4 address reachable at the router. If the provider uses CGNAT, or there is
another upstream router, forwarding only on the local router is insufficient. The WAN address shown
by the router must be the address passed as `-PublicIp` and encoded in `-PublicHost`.

For `77.40.53.96`, the sslip.io hostname is:

```text
77-40-53-96.sslip.io
```

Check it before starting:

```powershell
Resolve-DnsName 77-40-53-96.sslip.io
```

The returned IPv4 address must be `77.40.53.96`. For another address:

```powershell
$publicIp = '203.0.113.42'
$publicHost = ($publicIp -replace '\.', '-') + '.sslip.io'
Resolve-DnsName $publicHost
```

The sslip.io lookup is only for the fallback URL. The direct raw-IP certificate does not use DNS.

Prefer a reserved/static LAN address for the Windows computer. On the router, create a permanent
rule like this, substituting the actual LAN address:

```text
protocol: TCP
external port: 3100
internal host: 192.168.0.165
internal port: 3100
```

The final external check must be made from another network, such as a phone on mobile data. Some
routers do not support NAT loopback, so a public URL can work from the Internet but fail from inside
the same LAN.

## 2. Allow Windows Firewall

The first Caddy launch may show a Windows Firewall prompt. Allow it on the network profile used by
the computer. Alternatively, run an elevated PowerShell once:

```powershell
New-NetFirewallRule `
    -DisplayName 'wenay demo HTTPS 3100' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3100

New-NetFirewallRule `
    -DisplayName 'wenay demo ACME 3102' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3102
```

If different ports are passed to the launcher, use those ports in the firewall rules too.
`ChallengePort` must differ from both `PublicPort` and `BackendPort`.

## 3A. Start with automatic NAT-PMP

Use this path when the router supports NAT-PMP and it is enabled. The helper keeps a temporary
public `80 → local 3102` mapping alive while the stand runs.

```powershell
# Run these commands from the repository root.
npm install
$publicIp = '77.40.53.96' # replace with the router's reachable WAN address
$publicHost = ($publicIp -replace '\.', '-') + '.sslip.io'
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo-https.ps1 `
    -PublicIp $publicIp `
    -PublicHost $publicHost `
    -PublicPort 3100 `
    -BackendPort 3100 `
    -ChallengePort 3102
```

`npm install` is only needed after a fresh checkout or dependency change. For the repository’s
current addresses, the command above has this shortcut:

```powershell
npm run demo:https
```

When only `-PublicIp` is passed, the launcher derives the matching sslip.io fallback. When only an
IPv4 sslip.io `-PublicHost` is passed, it derives the raw IP. Passing both explicitly is clearer for
provisioning scripts. Use `-RawIpOnly` or `-HostnameOnly` when only one identity should be issued:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo-https.ps1 `
    -RawIpOnly `
    -PublicIp '77.40.53.96' `
    -PublicPort 3100 `
    -BackendPort 3100 `
    -ChallengePort 3102
```

That command is the pure direct-IP variant: it obtains and serves no DNS-name certificate.

If the launcher chooses the wrong network interface, specify the computer’s LAN address:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo-https.ps1 `
    -PublicIp '77.40.53.96' `
    -PublicHost '77-40-53-96.sslip.io' `
    -PublicPort 3100 `
    -BackendPort 3100 `
    -ChallengePort 3102 `
    -PublicBind '192.168.0.165'
```

## 3B. Start with manual port forwarding

Use this path if the router does not support NAT-PMP. In addition to the permanent application rule,
configure this router rule:

```text
protocol: TCP
external port: 80
internal host: 192.168.0.165
internal port: 3102
```

Then disable only the NAT-PMP helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo-https.ps1 `
    -SkipNatPmp `
    -PublicIp '77.40.53.96' `
    -PublicHost '77-40-53-96.sslip.io' `
    -PublicPort 3100 `
    -BackendPort 3100 `
    -ChallengePort 3102 `
    -PublicBind '192.168.0.165'
```

The manual TCP `80 → 3102` rule must remain available for future certificate renewal. It does not
serve the demo on port `80`; it only allows the ACME validation request through.

## What the launcher does

`scripts/start-demo-https.ps1`:

1. stops the previous managed stand;
2. builds `demo/public/`;
3. downloads Caddy `2.11.4` to `.tools/caddy.exe` on first use;
4. starts Node on `127.0.0.1:<BackendPort>`;
5. starts the NAT-PMP keeper unless `-SkipNatPmp` was passed;
6. starts Caddy on `<PublicBind>:<PublicPort>` as the TLS reverse proxy;
7. requests every enabled identity through ACME HTTP-01 — by default the ordinary hostname
   certificate and the raw-IP `shortlived` certificate;
8. sets the raw IP as Caddy's `default_sni`, because standards-compliant clients omit SNI when the
   URL host is an IP literal;
9. waits up to `CertificateWaitSeconds` per enabled certificate (120 seconds each by default) until
   it is trusted and the proxied application returns a successful response.

The essential raw-IP Caddy configuration generated for this machine is:

```caddyfile
{
    auto_https disable_redirects
    default_sni 77.40.53.96
}

https://77.40.53.96:3100 {
    bind 192.168.0.165

    tls {
        issuer acme https://acme-v02.api.letsencrypt.org/directory {
            profile shortlived
            alt_http_port 3102
            disable_tlsalpn_challenge
        }
    }

    reverse_proxy 127.0.0.1:3100
}
```

`profile shortlived` is what asks Let’s Encrypt for an IP SAN. `default_sni` is equally important:
an IP literal is not sent as an ordinary TLS SNI hostname, so Caddy needs this deterministic default
when several certificates share port `3100`. `alt_http_port 3102` moves only Caddy's local
challenge listener; Let’s Encrypt still connects to public port `80`.

Caddy’s `reverse_proxy` supports the WebSocket Upgrade used by Socket.IO; no separate WSS route is
required. The readiness check validates the certificate locally. It cannot prove that the router’s
public `3100 → 3100` rule is correct, so perform the external check below as well.

## 4. Verify the result

Do not add `-k` or `--insecure` to these checks: that would hide a broken certificate.

Check the local Node backend:

```powershell
curl.exe --noproxy '*' -I http://localhost:3100/
```

Check the direct-IP certificate and the hostname fallback:

```powershell
curl.exe --noproxy '*' -I https://77.40.53.96:3100/
curl.exe --noproxy '*' -I https://77-40-53-96.sslip.io:3100/
```

An `HTTP/1.1 200 OK` response without a certificate warning confirms HTTPS. Run these commands from a
machine outside the LAN to confirm the public route, not only local NAT loopback.

Inspect the served certificate without reading Caddy’s private-key files:

```powershell
$publicIp = '77.40.53.96'
$tcp = [System.Net.Sockets.TcpClient]::new($publicIp, 3100)
try {
    $tls = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false)
    try {
        $tls.AuthenticateAsClient($publicIp)
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($tls.RemoteCertificate)
        $san = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }
        [pscustomobject]@{
            SubjectAlternativeName = $san.Format($false)
            Issuer = $cert.Issuer
            NotBefore = $cert.NotBefore
            NotAfter = $cert.NotAfter
        }
    } finally {
        $tls.Dispose()
    }
} finally {
    $tcp.Dispose()
}
```

`AuthenticateAsClient($publicIp)` throws if trust or IP validation fails. On success,
`SubjectAlternativeName` contains `IP Address=77.40.53.96` and `Issuer` identifies Let’s Encrypt.
The certificate has no Common Name; the IP SAN is the identity browsers validate.

To check the local TLS endpoint without relying on router loopback:

```powershell
$publicIp = '77.40.53.96'
curl.exe --noproxy '*' --connect-to "${publicIp}:3100:192.168.0.165:3100" "https://${publicIp}:3100/" -I
```

Check the Socket.IO handshake:

```powershell
curl.exe --noproxy '*' 'https://77.40.53.96:3100/socket.io/?EIO=4&transport=polling'
```

The response starts with `0{...}`. To force a real WebSocket connection from the checkout:

```powershell
node -e "const {io}=require('socket.io-client'); const s=io('https://77.40.53.96:3100',{transports:['websocket']}); s.on('connect',()=>{console.log('connected',s.id);s.close()}); s.on('connect_error',e=>{console.error(e.message);process.exit(1)})"
```

Finally, open the public URL in a browser. In DevTools Console:

```javascript
window.isSecureContext
navigator.mediaDevices
```

The first value must be `true`; the second must exist. Camera and microphone still require browser
permission and an available device.

## State, logs, certificate, and renewal

Runtime files are local working state:

```text
.demo-https/state.json
.demo-https/caddy.err.log
.demo-https/caddy.out.log
.demo-https/nat-pmp.err.log
.demo-https/nat-pmp.out.log
.demo-https/backend.err.log
.demo-https/backend.out.log
```

Useful live log commands:

```powershell
Get-Content .\.demo-https\caddy.err.log -Wait
Get-Content .\.demo-https\nat-pmp.err.log -Wait
Get-Content .\.demo-https\backend.err.log -Wait
```

Caddy stores the durable ACME account, certificates, and private keys under `%APPDATA%\Caddy` when
the script runs under the normal Windows user. `.demo-https` can be recreated; `%APPDATA%\Caddy`
must persist. Do not commit, publish, or copy its private keys.

There is no manual renewal command. While Caddy is running, it monitors and renews managed
certificates automatically. The IP certificate is valid for 160 hours, so uninterrupted access to
public TCP `80 → local 3102` matters more than for the 90-day hostname certificate. The NAT-PMP
keeper renews its router mapping while the stand runs. After a stopped stand is started again, Caddy
reuses every still-valid stored certificate and renews it when needed.

Do not schedule a job that deletes and reissues the IP certificate every six days. Leave Caddy and
its storage in place; its renewal scheduler uses the CA's renewal information. If the server is
normally stopped, start it well before the certificate expires while public port `80` is reachable.

Do not delete `%APPDATA%\Caddy` merely to “try again”: it discards the ACME account and key material,
causes unnecessary new orders, and can run into CA rate limits.

## Stop and restart

```powershell
npm run demo:https:stop
```

This stops Node, Caddy, and the NAT-PMP keeper, removes the temporary NAT-PMP `80 → 3102` mapping,
and removes `.demo-https/state.json`. It does not delete the Caddy certificate and does not remove
the router’s permanent `3100 → 3100` rule. In `-SkipNatPmp` mode, the manually configured port `80`
rule also remains yours to manage.

Restart with the same start command. A valid stored certificate is reused immediately.

## Another IP or another 3100–3500 port

If the public IP changes, pass the new value as `-PublicIp` and create the matching fallback
`-PublicHost`. Neither old certificate can authenticate the new address. Caddy obtains both new
certificates automatically.

The HTTPS port can be changed independently. For example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo-https.ps1 `
    -PublicIp $publicIp `
    -PublicHost $publicHost `
    -PublicPort 3200 `
    -BackendPort 3200 `
    -ChallengePort 3202
```

Then change the application router rule to public TCP `3200 → local 3200` and open
`https://<public-ip>:3200/`. ACME still uses public TCP `80 → local 3202`.

## Troubleshooting

| Symptom | Cause and action |
| --- | --- |
| `NAT-PMP mapping request timed out` | NAT-PMP is disabled or unsupported. Configure both router rules manually and run with `-SkipNatPmp`. |
| `certificate was not ready after ... seconds` | Read `caddy.err.log`; normally `-PublicIp` is not the WAN IP, fallback DNS does not match it, public TCP `80` does not reach local `3102`, CGNAT/double NAT is present, or Windows Firewall blocks `3102`. For a slow but valid ACME path, restart with a larger `-CertificateWaitSeconds` value. |
| `ERR_CERT_COMMON_NAME_INVALID` on the IP URL | Confirm `-PublicIp`, keep `default_sni <PublicIp>` in the generated Caddyfile, and verify the served SAN is `IP Address=<PublicIp>`. An IP client normally sends no SNI. |
| `ERR_SSL_PROTOCOL_ERROR` | Public `3100` reached ordinary HTTP instead of Caddy TLS, Caddy is down, or the router forwards to the wrong host/port. |
| Public connection times out | Add/fix TCP `3100 → LAN_IP:3100`, the Windows Firewall rule, every upstream NAT layer, or the LAN address reservation. |
| HTTPS returns `502` | Certificate and Caddy work, but the Node backend is down. Read `backend.err.log`. |
| Page stays at `connecting…` | Test the Socket.IO polling URL and forced WebSocket command above. Caddy needs no separate WebSocket configuration. |
| Public URL works outside but not inside the LAN | The router probably lacks NAT loopback. Use the local HTTP URL for local work and an external network for the public test. |
| Camera/microphone is unavailable | Confirm the public page has `window.isSecureContext === true`, grant browser permission, and check the device. Plain external `http://<ip>` is not a secure context. |
| Port already belongs to another process | Inspect it with `Get-NetTCPConnection -State Listen -LocalPort 3100,3102` and choose another free port in `3100–3500` or stop the intended owner. |

## Official references

- [Let’s Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/) — HTTP-01 is validated on public port `80`.
- [Let’s Encrypt certificate profiles](https://letsencrypt.org/docs/profiles/) — the raw-IP `shortlived` profile is valid for 160 hours.
- [Let’s Encrypt IP-address certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/) — public IP certificates and automatic renewal.
- [RFC 8738](https://www.rfc-editor.org/rfc/rfc8738.html) — ACME validation and TLS behavior for IP identifiers.
- [Caddy `tls` directive](https://caddyserver.com/docs/caddyfile/directives/tls) — `alt_http_port`, issuers, and managed-certificate options.
- [Caddy `default_sni`](https://caddyserver.com/docs/caddyfile/options#default-sni) — selects the IP certificate when the client omits SNI.
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) — automatic issuance and renewal.
- [Caddy data directory](https://caddyserver.com/docs/conventions#data-directory) — persistent certificate and private-key storage.
- [Caddy addresses](https://caddyserver.com/docs/caddyfile/concepts#addresses) — HTTPS on a non-standard port.
- [sslip.io](https://sslip.io/) — DNS names that encode an IPv4 address.
