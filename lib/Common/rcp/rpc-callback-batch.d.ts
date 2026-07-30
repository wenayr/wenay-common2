import type { RpcBatchOpt } from './rpc-caps';
export declare const MAX_BATCH_ITEMS = 1024;
type tBatchedPacket = any[];
type CallbackPacketBatcherDeps = {
    send: (packet: any[]) => void;
    opt?: RpcBatchOpt;
    envelope?: number;
};
export declare function createCallbackPacketBatcher({ send, opt, envelope, }: CallbackPacketBatcherDeps): {
    enqueue: (packet: tBatchedPacket) => void;
    flush: () => void;
};
export {};
