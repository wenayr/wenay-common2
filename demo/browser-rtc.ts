import type {
    RtcDataChannel, RtcPeerConnection, RtcSessionDescription,
} from '../src/Common/events/route-signal-webrtc'

type BrowserDataChannel = Pick<RTCDataChannel, 'binaryType' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>
type BrowserRtcConnection = Pick<RtcPeerConnection, 'createOffer' | 'createAnswer'> & Pick<RTCPeerConnection,
    'setLocalDescription' | 'setRemoteDescription' | 'addIceCandidate'
    | 'close' | 'onicecandidate' | 'ondatachannel'> & {
        createDataChannel: (label: string) => BrowserDataChannel
    }

function browserDescription(description: RtcSessionDescription): RTCSessionDescriptionInit {
    const {type, sdp} = description
    if (type != 'offer' && type != 'answer' && type != 'pranswer' && type != 'rollback') {
        throw new TypeError('unsupported RTC session description type')
    }
    return {type, sdp}
}

function browserCandidate(candidate: unknown): RTCIceCandidateInit | undefined {
    if (candidate == null) return undefined
    if (typeof candidate != 'object') throw new TypeError('RTC candidate must be an object')
    const text = 'candidate' in candidate ? candidate.candidate : undefined
    const sdpMid = 'sdpMid' in candidate ? candidate.sdpMid : undefined
    const sdpMLineIndex = 'sdpMLineIndex' in candidate ? candidate.sdpMLineIndex : undefined
    const usernameFragment = 'usernameFragment' in candidate ? candidate.usernameFragment : undefined
    if (text != undefined && typeof text != 'string'
        || sdpMid != null && typeof sdpMid != 'string'
        || sdpMLineIndex != null && typeof sdpMLineIndex != 'number'
        || usernameFragment != null && typeof usernameFragment != 'string') {
        throw new TypeError('invalid RTC candidate fields')
    }
    return {candidate: text ?? undefined, sdpMid, sdpMLineIndex, usernameFragment}
}

function adaptDataChannel(channel: BrowserDataChannel) {
    const handlers: Pick<RtcDataChannel, 'onopen' | 'onmessage' | 'onclose' | 'onerror'> = {}
    const adapted = {
        ...handlers,
        get binaryType() { return channel.binaryType },
        set binaryType(value: string) {
            if (value != 'arraybuffer' && value != 'blob') throw new TypeError('unsupported RTC binary type')
            channel.binaryType = value
        },
        send(data: string | ArrayBuffer | ArrayBufferView) {
            if (typeof data == 'string') channel.send(data)
            else if (data instanceof ArrayBuffer) channel.send(data)
            else if (data.buffer instanceof ArrayBuffer) {
                channel.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
            }
            // DOM send overloads exclude SharedArrayBuffer-backed views.
            else channel.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice())
        },
        close() { channel.close() },
    } satisfies RtcDataChannel
    channel.onopen = function opened(event) { adapted.onopen?.(event) }
    channel.onmessage = function received(event) { adapted.onmessage?.(event) }
    channel.onclose = function closed(event) { adapted.onclose?.(event) }
    channel.onerror = function failed(event) { adapted.onerror?.(event) }
    return adapted
}

// DOM validation belongs to this browser resource, not the transport-neutral library contract.
export function createBrowserRtc(deps: {connection: BrowserRtcConnection}) {
    const {connection} = deps
    const handlers: Pick<RtcPeerConnection, 'onicecandidate' | 'ondatachannel'> = {}
    const adapted = {
        ...handlers,
        createDataChannel(label: string, options?: unknown) {
            // The demo's replay connector only requests the default ordered channel.
            if (options != undefined) throw new TypeError('demo RTC adapter uses default data channel options')
            return adaptDataChannel(connection.createDataChannel(label))
        },
        createOffer() { return connection.createOffer() },
        createAnswer() { return connection.createAnswer() },
        setLocalDescription(description: RtcSessionDescription) {
            return connection.setLocalDescription(browserDescription(description))
        },
        setRemoteDescription(description: RtcSessionDescription) {
            return connection.setRemoteDescription(browserDescription(description))
        },
        addIceCandidate(candidate: unknown) { return connection.addIceCandidate(browserCandidate(candidate)) },
        close() { connection.close() },
    } satisfies RtcPeerConnection
    connection.onicecandidate = function iceCandidate(event) { adapted.onicecandidate?.(event) }
    connection.ondatachannel = function dataChannel(event) { adapted.ondatachannel?.({channel: adaptDataChannel(event.channel)}) }
    return adapted
}
