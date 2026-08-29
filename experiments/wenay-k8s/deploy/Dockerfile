# wenay mini-node image — runs demo/mini-scale-node.ts as a pod.
# Build FROM THE REPO ROOT (the context must contain package.json, src/, demo/):
#   minikube image build -t wenay-mini-node:dev -f experiments/wenay-k8s/deploy/Dockerfile .
#
# Dependency decision (documented honestly): this repo ships only axios+express
# as "dependencies" — the mini node's real runtime needs (tsx, socket.io,
# socket.io-client) are devDependencies here, so `npm ci --omit=dev` would be
# structurally WRONG for this image, not merely lean. KISS wins: one full
# `npm ci` from the lockfile, reproducible and honest. The lean alternative
# (esbuild-prebundle the node into one JS file, no node_modules) is the
# graduation-time optimization, not worth a second build system for a local
# minikube stand.
FROM node:22-alpine

WORKDIR /app

# lockfile-first: layer cache survives source edits
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY demo ./demo

# MINI_UPSTREAM default reaches the host machine's demo leader from inside
# minikube; MINI_NODE_ID / MINI_TOKEN / MINI_SECRET come from the pod spec
# (fieldRef + Secret) — see k8s.yaml.
ENV MINI_UPSTREAM=http://host.minikube.internal:3100

CMD ["node", "node_modules/tsx/dist/cli.mjs", "demo/mini-scale-node.ts"]
