import type { RpcOpt } from './rpc-caps';
type tCallbackPacket = any[];
type CallbackPacketBatcherDeps = {
    send: (packet: any[]) => void;
    opt?: RpcOpt['callbackBatch'];
};
export declare function createCallbackPacketBatcher({ send, opt, }: CallbackPacketBatcherDeps): {
    enqueue: (packet: tCallbackPacket) => void;
    flush: () => void;
};
export {};
