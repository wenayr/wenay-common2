// Compile-time oracle for Replicated Map inference through the ordinary RPC projection.

import {
    createReplicatedMap, followReplicatedMap, ReplicatedMapRemote, StoreReplayRemote,
} from '../src/Common/Observe'
import {ClientAPIAll} from '../src/Common/rcp/rpc-client'

type Item = {id: 'only', value: number}
type Projected = ClientAPIAll<{map: ReplicatedMapRemote<Item, 'only'>}>

function projectedRemoteKeepsMapTypes(remote: Projected['map']) {
    const follower = followReplicatedMap(remote)
    const value: Item | undefined = follower.get('only')
    const snapshotValue: Item | undefined = follower.snapshot().only
    void value
    void snapshotValue

    // @ts-expect-error the descriptor-carried literal key survives ClientAPIAll
    follower.get('wrong')
}

function producerGetIsNotAny() {
    const producer = createReplicatedMap<Item, 'only'>({
        keyOf(value) { return value.id },
        delivery: 'latest',
    })
    const value: Item | undefined = producer.control.get('only')
    void value

    // @ts-expect-error get() is Item | undefined, not any
    const wrong: number = producer.control.get('only')
    void wrong
}

function legacyStoreReplayCanBeTypedExplicitly(remote: StoreReplayRemote) {
    const follower = followReplicatedMap<Item, 'only'>(remote, {delivery: 'latest'})
    const value: Item | undefined = follower.get('only')
    void value
}

void projectedRemoteKeepsMapTypes
void producerGetIsNotAny
void legacyStoreReplayCanBeTypedExplicitly
