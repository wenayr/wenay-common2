import type { AiRun, AiRunApproval, AiRunInput, AiRunRequest, AiRunStore } from './ai-run-host';
export type AiRunCheckpoint = {
    version: 1;
    revision: number;
    store: AiRunStore;
    requests: Record<string, AiRunRequest>;
    inputValues: Record<string, unknown>;
};
export type AiRunPersistencePort = {
    commit(checkpoint: AiRunCheckpoint): undefined;
};
export type AiRunRecoveryRecord = {
    run: AiRun;
    request: AiRunRequest;
    approvals: AiRunApproval[];
    inputs: (AiRunInput & {
        value?: unknown;
    })[];
};
export declare function restoreAiRunCheckpoint(initial: AiRunCheckpoint | undefined): AiRunCheckpoint;
