import { ReplayRemote } from './replay-wire';
export type ReplayMessageChannel = {
    send: (data: string) => void;
    onMessage: (cb: (data: string) => void) => (() => void) | void;
    onClose?: (cb: () => void) => (() => void) | void;
    close?: () => void;
};
export declare function serveReplayChannel<Z extends any[]>(source: ReplayRemote<Z>, channel: ReplayMessageChannel): () => void;
export declare function channelReplayRemote<Z extends any[]>(channel: ReplayMessageChannel): ReplayRemote<Z>;
