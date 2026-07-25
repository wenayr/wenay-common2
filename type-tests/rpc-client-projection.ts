import type {createListen} from '../src/Common/events/Listen'
import type {DeepSocketListen, DeepSocketListenSmart} from '../src/Common/rcp/listen-deep'
import type {ClientAPIAll} from '../src/Common/rcp/rpc-client'

type tBatchV2 = [2, number, number, unknown[]]

type tBatch = {
    line: {
        on(cb: (wire: tBatchV2) => void): Promise<void>
    }
    keyframe(): tBatchV2
}

type tReplayFacade = {
    replay: tBatch
    readBuffer(): ArrayBuffer
    readBytes(): Uint8Array
    readView(): DataView
}

type tProjected = ClientAPIAll<DeepSocketListenSmart<tReplayFacade>>
declare const projected: tProjected

async function projectedOptionalBinaryMembersStayTyped() {
    const buffer: ArrayBuffer = await projected.readBuffer()
    const bytes: Uint8Array = await projected.readBytes()
    const view: DataView = await projected.readView()
    const keyframe: tBatchV2 = await projected.replay.keyframe()
    projected.replay.line.on(function consumeV2Wire(wire) {
        const exact: tBatchV2 = wire
        void exact
    })

    // @ts-expect-error Uint8Array must not degrade to any or a mapped plain object
    const wrong: string = await projected.readBytes()
    void buffer
    void bytes
    void view
    void keyframe
    void wrong
}

type tOptionalListenFacade = {
    binary?: ReturnType<typeof createListen<[Uint8Array]>> | null
}

type tOptionalListenProjection = DeepSocketListen<tOptionalListenFacade>
declare const optionalListenProjection: tOptionalListenProjection

function optionalListenKeepsTheProjectedHandle() {
    const handle = optionalListenProjection.binary!.on(function consumeOptionalBinary(wire) {
        const exact: Uint8Array = wire
        void exact
    })
    handle.off()
}

void projectedOptionalBinaryMembersStayTyped
void optionalListenKeepsTheProjectedHandle
