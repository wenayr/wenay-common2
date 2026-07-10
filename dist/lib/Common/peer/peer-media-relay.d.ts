import { ListenReplayApi } from '../events/replay-listen';
export type tMediaRelayKind = 'video' | 'audio';
export type tCanWatch = (watcher: string, owner: string, line: string) => boolean;
export type MediaRelayDeps = {
    lines: Record<string, tMediaRelayKind>;
    videoHistory?: number;
    audioHistory?: number;
    canWatch?: tCanWatch;
};
type tMediaFrame = [unknown, number];
type tRelayLine = ListenReplayApi<tMediaFrame>;
export declare function createMediaRelay(deps: MediaRelayDeps): {
    publishOf: (account: string) => (line: string, frame: unknown, sentAt: number) => void;
    watch: Record<string, Record<string, tRelayLine>>;
    watchOf: (watcher: string) => Record<string, Record<string, tRelayLine>>;
    lines: (account: string) => Record<string, tRelayLine>;
    accounts: () => string[];
    dropAccount: (account: string) => void;
    close(): void;
};
export type MediaRelay = ReturnType<typeof createMediaRelay>;
export {};
