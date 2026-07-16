# Conversation runtime — channels, blocks and scoped facts

## Purpose

`Conversation` is the application-facing dialogue model above RPC, Store/Replay, AI runs,
Resources and Artifacts. It does not add another transport. One authenticated RPC connection may
carry any number of logical conversations and channels.

```text
conversation
  root channel
    messages -> declarative blocks
    scoped facts
    child channel -> its own messages and facts
```

A child channel is a first-class branch linked to the message that created it. It is not a nested
message array. This keeps channel ACL, history, AI context and fact inheritance independently
addressable.

## Ownership boundaries

| Concern | Owner |
| --- | --- |
| Current conversation/channel/message/fact projection | Conversation host + filtered Store/replay |
| Command authorization and participant policy | Conversation host policy |
| Durable event journal and idempotency receipts | Injected persistence adapter |
| Model execution and model credentials | AI runner adapter |
| File/application bytes and signed URLs | Resource/Artifact storage adapters |
| Rendering `custom` blocks | Local application renderer registry |
| Executing a generated application | Artifact sandbox runtime |

The Conversation Store contains no persistence handle, model credential, storage key, executable
code or arbitrary renderer function.

## Core records

```ts
type Conversation = {
  id: string
  owner: string
  title: string
  participantIds: string[]
  rootChannelId: string
  state: 'open' | 'closed'
  createdAt: number
  updatedAt: number
}

type ConversationChannel = {
  id: string
  conversationId: string
  title: string
  createdBy: string
  parent?: {channelId: string; messageId: string}
  factMode: 'inherit' | 'isolated'
  state: 'open' | 'closed'
  createdAt: number
  updatedAt: number
}
```

The root channel is created atomically with the conversation. A child created from a message stores
both its parent channel and anchor message. `inherit` makes conversation and ancestor-channel facts
visible; `isolated` starts with only facts scoped to that channel.

## Messages and block versioning

Messages are immutable in v1. A correction is a new message or a fact revision; silent mutation of
old dialogue would destroy provenance. Every block has a stable server id and an explicit
`version: 1`.

Built-in block kinds are:

- `text` — plain text;
- `list` — bullet, ordered or check items with stable item ids;
- `table` — named columns and JSON-like row data;
- `fact` — reference to a Conversation fact;
- `resource` — reference to Resource metadata/bytes;
- `artifact` — reference to an Artifact descriptor;
- `custom` — `{type, version, data}` interpreted only by a locally registered renderer.

Block payloads and fact values are JSON-like data: null, finite numbers, booleans, strings, arrays
and plain objects. Functions, symbols, class instances, cycles and executable markup are rejected.
An unknown custom type remains inspectable data and must render as a safe fallback. A full
interactive application uses the Artifact layer instead.

## Facts

A fact is keyed by `(conversation, scope, namespace, key)` and keeps a stable id:

```ts
type ConversationFact = {
  id: string
  conversationId: string
  scope: {kind: 'conversation'} | {kind: 'channel'; channelId: string}
  namespace: string
  key: string
  value: unknown
  revision: number
  state: 'active' | 'retracted'
  provenance: ConversationFactSource[]
  createdBy: string
  createdAt: number
  updatedAt: number
}
```

`expectedRevision` provides optimistic concurrency. Missing fact is revision `0`; each upsert or
retraction increments the revision. A narrower channel fact overrides the same namespace/key from
an ancestor. A retracted narrower fact is a tombstone, so the inherited value does not unexpectedly
reappear.

Client-originated provenance always includes the authenticated account. It may additionally point
to a source message after the host verifies that message belongs to the same conversation. Trusted
server integrations may append an AI-run or system source through the control facade.

## Commands and idempotency

Every mutating client command requires an account-scoped `requestId`:

```ts
createConversation({requestId, title, participantIds})
createChannel({requestId, conversationId, title, parentMessageId?, factMode?})
postMessage({requestId, conversationId, channelId, blocks})
upsertFact({requestId, conversationId, scope, namespace, key, value, expectedRevision?})
retractFact({requestId, conversationId, factId, expectedRevision?})
```

Repeating the same request returns the first entity without another side effect. Reusing one
request id for another command is rejected.

The host keeps receipts outside the replicated Store. A persistence adapter receives the semantic
event and receipt together before the mutation becomes visible. It must commit them atomically and
idempotently. A restart-safe application passes its rehydrated Store projection and receipts back as
`initial`; without that adapter the host is intentionally an in-memory runtime.

## Projection and replay

`connection(account)` exposes only conversations readable by that account plus related channels,
messages and facts. The fragment contains the Store replay, a filtered semantic event replay and
authorized commands. Other conversations do not appear as empty shells and cannot be addressed by
guessing ids.

The v1 host retains its complete working set. That is suitable for the stand and bounded services,
not an unlimited chat archive. A production adapter must partition/bound the host or add archived
history pagination before accepting unbounded retention. Reducing replay history is not a message
retention mechanism.

## AI and Artifact integration

Conversation does not call a model or execute an artifact. A server bridge may:

1. start an AI run with `conversationId` and `channelId` in its input;
2. append the final assistant message through the trusted control facade;
3. store extracted facts with AI-run/message provenance;
4. place Resource and Artifact ids into message blocks.

A future artifact-to-conversation bridge is a separately versioned capability protocol. It may
offer narrow operations such as `readFacts`, `proposeFact` or `postMessage`, bound to one channel,
origin-checked and revocable. An artifact never receives the raw Conversation RPC facade.

## Stand acceptance path

1. Two participants see the same root channel over one existing RPC connection each.
2. Either participant posts text and structured list/table/custom blocks.
3. A message forks into a child channel without copying parent history.
4. Conversation facts flow into an inheriting child; channel facts override or tombstone them.
5. A non-participant sees no records and cannot post, fork or mutate facts.
6. Duplicate request ids do not duplicate effects; stale fact revisions fail.
7. Reconnection restores the filtered projection and semantic event cursor.
8. A failed persistence commit leaves Store and events unchanged.
