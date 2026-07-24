import type { RpcOpt } from './rpc-caps';
type tCallbackPacket = any[];
type CallbackPacketBatcherDeps = {
    send: (packet: any[]) => void;
    opt?: RpcOpt['callbackBatch'];
    acceptBinary?: boolean;
    measure?: (packet: any[]) => number;
};
export declare function callbackBatchDirectBinaryOversize(values: readonly unknown[], opt?: RpcOpt['callbackBatch']): boolean;
export declare function createCallbackPacketBatcher({ send, opt, acceptBinary, measure, }: CallbackPacketBatcherDeps): {
    enqueue: (packet: tCallbackPacket) => void;
    flush: () => void;
};
export {};
