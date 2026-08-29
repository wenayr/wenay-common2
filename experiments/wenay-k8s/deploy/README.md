# wenay-k8s deploy — minikube runbook (run AFTER the cluster exists)

Everything here was prepared without a cluster. Once `minikube start --driver=hyperv` succeeds,
the stand lands with the sequence below. All commands are PowerShell, from the repo root.

## 0. One-time: credentials (the Secret handoff)

The demo leader generates the mini-node trust `token` and the scale corridor `secret` **randomly
per run and never prints them** — the secret is not even returned from the host factory, so there
is no console to scrape. The honest handoff therefore runs the OTHER way: the operator picks both
values and hands them to BOTH sides — the leader via `DEMO_MINI_TOKEN`/`DEMO_MINI_SECRET`
(additive override in `demo/mini-scale-host.ts`; unset = old behavior, random per run), and the
pods via the k8s Secret. Pinning the token also widens the leader's `acceptNode` gate, which is
otherwise children-only and would refuse every pod's registration.

```powershell
# any two hard-to-guess strings; keep them for the whole session
$env:DEMO_MINI_TOKEN  = 'mini-'  + [guid]::NewGuid().ToString('n')
$env:DEMO_MINI_SECRET = 'scale-' + [guid]::NewGuid().ToString('n')
```

## 1. Start the leader (host machine)

```powershell
npm run demo
```

The demo binds the first free port from 3100 — keep it AT 3100 (close whatever occupies it
first), because the pods dial `http://host.minikube.internal:3100`. The server listens on all
interfaces by default; if pods cannot connect, allow inbound TCP 3100 for the Hyper-V switch in
Windows Firewall.

## 2. Sanity: the cluster answers, feeder against real pods

```powershell
node node_modules/tsx/dist/cli.mjs experiments/wenay-k8s/cluster-check.ts
```

No cluster → one line `no reachable cluster — start minikube first`, exit 1, never hangs.
With the cluster: a throwaway namespace, a pause Deployment, the REAL kube source feeding the
REAL node directory, scale up/down asserted as rows appearing/draining, namespace deleted,
`ALL GREEN`.

## 3. Build the mini-node image INTO minikube

```powershell
minikube image build -t wenay-mini-node:dev -f experiments/wenay-k8s/deploy/Dockerfile .
```

Context is the repo root (the trailing dot). No registry, no push — the image lands directly in
the cluster runtime; the manifests use `imagePullPolicy: Never`.

## 4a. Deploy with kubectl

```powershell
(Get-Content experiments/wenay-k8s/deploy/k8s.yaml -Raw) `
    -replace 'REPLACE_WITH_DEMO_MINI_TOKEN',  $env:DEMO_MINI_TOKEN `
    -replace 'REPLACE_WITH_DEMO_MINI_SECRET', $env:DEMO_MINI_SECRET `
    | kubectl apply -f -
```

## 4b. …or deploy with helm (same manifests)

```powershell
helm install wenay-mini experiments/wenay-k8s/deploy/helm-chart `
    --namespace wenay-mini --create-namespace `
    --set secret.miniToken=$env:DEMO_MINI_TOKEN `
    --set secret.miniSecret=$env:DEMO_MINI_SECRET
```

## 5. Watch the stand

```powershell
kubectl -n wenay-mini get pods -w
```

Each pod registers itself at the leader (`MINI_NODE_ID` = pod name via fieldRef), so the demo
admin panel shows pods as directory rows within a heartbeat or two. Then:

- `kubectl -n wenay-mini scale deployment wenay-mini-node --replicas=4` — rows appear live;
- `kubectl -n wenay-mini delete pod <name>` — the Drain button: SIGTERM → the node's own leave
  path (drain fact → grace → goodbye → exit 0), per `../k8s-lifecycle.md`. The Deployment then
  recreates the pod under a NEW name — under a Deployment, drain means restart, by design.

## Honest limitations of this first stand

- **Reader placement onto pods does not work yet.** The mini node binds an EPHEMERAL port and
  registers `url: http://localhost:<port>` — meaningless outside the pod. Registration,
  replication (the pod dials OUT to the leader), heartbeats, revocation facts and drains all
  flow; browser readers simply stay routed to the leader because pod offers are unreachable.
  Fixing it needs a fixed serving port + a per-pod reachable URL (hostPort/NodePort or headless
  Service + ingress) — a `demo/mini-scale-node.ts` change outside this prep's scope.
- **No readiness probe** in the manifests, deliberately: no fixed port, no `/readyz` served —
  `../k8s-probes.ts` is ready for the day the node mounts it on a fixed port.
- **Dockerfile installs everything** (`npm ci`, no `--omit=dev`): tsx, socket.io and
  socket.io-client are devDependencies of this repo, so a prod-only install would not even run.
  Lean prebundling is a graduation-time optimization.
- `Dockerfile.dockerignore` needs BuildKit (minikube's builders use it); a legacy builder just
  uploads a fatter context, nothing breaks.

## The additive demo change (the whole diff outside experiments/wenay-k8s)

`demo/mini-scale-host.ts`:

```ts
const pinnedToken = process.env.DEMO_MINI_TOKEN?.trim() || null
const pinnedSecret = process.env.DEMO_MINI_SECRET?.trim() || null
const token = pinnedToken ?? 'mini-' + …   // was: 'mini-' + …
const secret = pinnedSecret ?? 'scale-' + …   // was: 'scale-' + …
…
acceptNode: nodeId => children.has(nodeId) || pinnedToken != null,   // was: children.has(nodeId)
```

Both env vars unset → byte-identical behavior to before.
