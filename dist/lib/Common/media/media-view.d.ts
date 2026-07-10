type tMediaLine = {
    on(cb: (frame: any, sentAt?: number) => void): any;
};
export type AttachVideoCanvasOpts = {
    createBitmap?: (blob: any) => Promise<any>;
    onError?: (e: unknown) => void;
};
export declare function attachVideoCanvas(line: tMediaLine, canvas: any, opts?: AttachVideoCanvasOpts): {
    stats: () => {
        frames: number;
        drawn: number;
        perSec: number;
        ageMs: number;
        width: number;
        height: number;
    };
    off: () => void;
};
export type AttachAudioPlayerOpts = {
    maxBacklogSec?: number;
    audioContext?: () => any;
    onError?: (e: unknown) => void;
};
export declare function attachAudioPlayer(line: tMediaLine, opts?: AttachAudioPlayerOpts): {
    enable(): void;
    disable(): void;
    readonly enabled: boolean;
    stats: () => {
        frames: number;
        played: number;
        dropped: number;
        perSec: number;
        ageMs: number;
    };
    off: () => void;
};
export type PipeMediaPublishOpts = {
    stamp?: boolean;
    onError?: (e: unknown) => void;
};
export declare function pipeMediaPublish(line: tMediaLine, publish: (frame: Uint8Array, sentAt?: number) => unknown, opts?: PipeMediaPublishOpts): any;
export {};
