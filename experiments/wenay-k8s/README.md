# wenay-k8s — Kubernetes host package (incubating skeleton)

Future separate npm package (working name `wenay-k8s`), stage 5 of
[`doc/target/SCALE-DEPLOY-PLAN.md`](../../doc/target/SCALE-DEPLOY-PLAN.md), incubated here the same
way `experiments/dynamic-runtime` incubates its control plane: dev-only, unexported, no new
dependencies, proven by its own self-check.

## Ownership boundary

Per [`doc/DYNAMIC-RUNTIME.md`](../../doc/DYNAMIC-RUNTIME.md) this package is a **host**: it owns
deployment, discovery and lifecycle, and adapts them onto library seams. It re-implements **no
replication, no second directory, no consensus**. The node directory stays the library contract —
clients balance on its rows exactly as before — and Kubernetes is **one feeder** of that contract.

## What the skeleton covers

- `kube-source.ts` — the port between the K8s API and the feeder (`list` + `watch`, informer-shaped
  events) plus `createFakeKubeApi` with control verbs for the self-check.
- `kube-source-real.ts` — the REAL implementation of the same port over `@kubernetes/client-node`
  (dev dependency): kubeconfig via the default loading rules, list+watch of the namespace's pods
  under a label selector, resourceVersion resume, bounded-backoff reconnect, relist delivered as
  the port's `sync`. The feeder cannot tell fake from real — that is the port's whole point.
- `k8s-directory-feeder.ts` — pod facts driving `createNodeDirectory`'s control verbs:

  | pod fact | directory verb |
  | --- | --- |
  | appears (first sighting) | `upsert {nodeId: name, url, role (default mirror), weight: ready ? weightOf (default 4) : 0}` |
  | `ready=false` on a known pod | `heartbeat(name, {weight: 0})` — closed, existing clients move away |
  | `ready=true` on a known pod | `heartbeat(name, {weight: weightOf(pod)})` |
  | `deleting` (deletionTimestamp) | `drain(name)` — the library moves clients losslessly; one-way |
  | gone (delete event / missing from sync) | `remove(name)` |
  | still present, every `heartbeatMs` | `heartbeat(name)` — staleness keeps meaning "feeder dead" |

- `k8s-probes.ts` — `readyz`/`livez` handlers answering from the `createNodeHealth` store (ready =
  no part recorded the store's own `{error}` failure shape; live = the loop answers at all).
- `k8s-lifecycle.md` — the preStop/SIGTERM → drain → gap-free departure → exit shape, mapped onto
  the existing demo leave path; the Lease-election TODO mapped onto the replica set's
  `leadership.elect/accept` seam. Documentation only — no pretend stubs.
- `self-check.ts` — the acceptance: fake kube api → feeder → **real** directory, probes from a
  **real** health store, and one integration proof that `kubectl delete pod` (marking the serving
  pod deleting) moves a real replica-set client to another node with identical snapshots.

- `cluster-check.ts` — the acceptance against a REAL cluster: throwaway namespace, a tiny pause
  Deployment, `kube-source-real` → the unchanged feeder → the real directory; API-driven scale
  up/down asserted as rows appearing/draining; the namespace deleted pass or fail. Without a
  reachable cluster it exits with one line (`no reachable cluster — start minikube first`),
  non-zero, never hangs.
- `deploy/` — everything the minikube stand needs once the cluster exists: `Dockerfile`
  (+ `Dockerfile.dockerignore`) building the mini-node image from this repo, `k8s.yaml`
  (Namespace, Secret placeholder, Deployment with the drain-fitting lifecycle), `helm-chart/`
  rendering the same manifests, and `deploy/README.md` — the exact post-minikube runbook,
  including the credentials handoff (`DEMO_MINI_TOKEN`/`DEMO_MINI_SECRET` pin the leader's
  per-run values so pods can join).

```powershell
npx tsx experiments/wenay-k8s/self-check.ts
node node_modules/tsx/dist/cli.mjs experiments/wenay-k8s/cluster-check.ts   # after minikube is up
```

## After the cluster exists

Follow [`deploy/README.md`](deploy/README.md): pin the credentials, `npm run demo`, run
`cluster-check.ts`, `minikube image build`, `kubectl apply`/`helm install`, then
`kubectl scale`/`kubectl delete pod` live against the demo panel.

## Deferred (deliberately not in the skeleton)

- Lease election into `createStoreReplicaSet`'s `leadership.elect/accept` seam (see
  `k8s-lifecycle.md` — needs a real Lease to be honest; plan step 6c).
- Reader placement onto pods: the mini node binds an ephemeral port and registers a pod-local
  URL, so browser readers stay on the leader; needs a fixed serving port + per-pod reachable URL
  (see `deploy/README.md` limitations).
- Dynamic updates over the Contract-runtime corridor (plan step 6e, ships last).

## Graduation plan

When the stage-3/4 library surface settles (including the pending `createStoreNode` promotion
decision), this directory lifts into its own repository/package `wenay-k8s` with `wenay-common2` as
a normal dependency: imports flip from `../../src/...` to the package entrypoints, the self-check
becomes the package oracle, and the real client, Lease election and Helm chart land there against a
kind/minikube stand — the intermediate stand being the step-4 admin panel listing pods from a kind
cluster.
