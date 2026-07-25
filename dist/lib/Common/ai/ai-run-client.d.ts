import { StoreDrain } from '../Observe/store';
import { StoreReplayRemote } from '../Observe/store-replay';
import { ReplayRemote } from '../events/replay-wire';
import { AiCapability, AiRun, AiRunApproval, AiRunEvent, AiRunInput, AiRunRequest, AiRunStore } from './ai-run-host';
export type AiRunRemote = {
    capabilities: () => Promise<AiCapability[]> | AiCapability[];
    state: StoreReplayRemote;
    events: ReplayRemote<[AiRunEvent]>;
    createRun: (request: AiRunRequest) => Promise<AiRun> | AiRun;
    cancelRun: (runId: string, reason?: string) => Promise<AiRun> | AiRun;
    resolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<AiRunApproval> | AiRunApproval;
    provideInput: (inputId: string, value: unknown) => Promise<AiRunInput> | AiRunInput;
};
export type AiRunClientDeps = {
    remote: AiRunRemote;
    initial?: AiRunStore;
    drain?: StoreDrain;
};
export declare function createAiRunClient(deps: AiRunClientDeps): {
    store: import("../Observe").Store<AiRunStore>;
    events: import("../..").ListenApi<[AiRunEvent]>;
    ready: Promise<void>;
    stateSeq: () => number;
    stateMode: () => "v2";
    eventSeq: () => number;
    capabilities: () => Promise<AiCapability[]>;
    createRun: (request: AiRunRequest) => Promise<AiRun>;
    cancelRun: (runId: string, reason?: string) => Promise<AiRun>;
    resolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<AiRunApproval>;
    provideInput: (inputId: string, value: unknown) => Promise<AiRunInput>;
    close(): void;
};
export type AiRunClient = ReturnType<typeof createAiRunClient>;
