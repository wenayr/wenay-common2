import type {createListen} from '../src/Common/events/Listen'
import type {DeepSocketListen, DeepSocketListenSmart} from '../src/Common/rcp/listen-deep'
import type {ClientAPIAll} from '../src/Common/rcp/rpc-client'

type tBatchV5 = {
    line: {
        on(cb: (wire: Uint8Array) => void): Promise<void>
    }
    keyframe(): Uint8Array
}

type tReplayFacade = {
    replay: {
        batch?: {
            v5?: tBatchV5 | null
        } | null
    }
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
    const keyframe: Uint8Array = await projected.replay.batch!.v5!.keyframe()
    projected.replay.batch!.v5!.line.on(function consumeBinaryWire(wire) {
        const exact: Uint8Array = wire
        void exact
    })

    let optionalBatch: tProjected['replay']['batch']
    optionalBatch = null
    optionalBatch = undefined

    // @ts-expect-error Uint8Array must not degrade to any or a mapped plain object
    const wrong: string = await projected.readBytes()
    void buffer
    void bytes
    void view
    void keyframe
    void optionalBatch
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
