export declare const RPC_REPLAY_WIRE_SOURCE: unique symbol;
export type RpcReplayWireSource = {
    head: () => number;
    sequenceOf: (event: unknown) => number | undefined;
};
export declare function brandRpcReplayWire<T extends object>(facade: T, source: RpcReplayWireSource): T;
export declare function getRpcReplayWireSource(value: any): RpcReplayWireSource | undefined;
export declare function retransmitRpcReplayWire<T extends object>(source: object, facade: T): T;
