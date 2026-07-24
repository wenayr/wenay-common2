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
    batch?: boolean;
};
export declare function createAiRunClient(deps: AiRunClientDeps): {
    store: import("../Observe/store").Store<AiRunStore>;
    events: import("../events/Listen").ListenApi<[AiRunEvent]>;
    ready: Promise<void>;
    stateSeq: () => number;
    stateMode: () => import("../Observe/store-replay").tStoreReplayMode;
    eventSeq: () => number;
    capabilities: () => Promise<AiCapability[]>;
    createRun: (request: AiRunRequest) => Promise<AiRun>;
    cancelRun: (runId: string, reason?: string) => Promise<AiRun>;
    resolveApproval: (approvalId: string, decision: "approved" | "rejected") => Promise<AiRunApproval>;
    provideInput: (inputId: string, value: unknown) => Promise<AiRunInput>;
    close(): void;
};
export type AiRunClient = ReturnType<typeof createAiRunClient>;
