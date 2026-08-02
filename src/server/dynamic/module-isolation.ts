import {VerifiedModuleArtifact} from '../../Common/dynamic/module-verifier'

// =====================================================================
// Module isolation port — verified artifacts in, isolated sessions out
// =====================================================================

export type ModuleIsolationCallOptions = {
    correlationId: string
    bindingGeneration?: number
    timeoutMs?: number
    signal?: AbortSignal
}

export type tModuleIsolationMcpLifetime = 'host' | 'generation' | 'session'

export type ModuleIsolationMcpRegistration = {
    registrationId: number
    descriptor: {
        contributionId: string
        lifetime: tModuleIsolationMcpLifetime
        toolId: string
        title?: string
        description?: string
        annotations?: {
            readOnlyHint: boolean
            destructiveHint: boolean
            idempotentHint: boolean
        }
    }
    state: 'accepted' | 'attached' | 'detached' | 'rejected' | 'removed'
    reason?: string
}

export type tModuleIsolationEvent =
    | {type: 'state', state: string, at: number, reason?: string}
    | {type: 'heartbeat', at: number}
    | {type: 'call', phase: string, callId: number, method: string, correlationId: string, at: number}
    | {
        type: 'mcp'
        phase: 'accepted' | 'attached' | 'detached' | 'rejected' | 'removed'
        registration: ModuleIsolationMcpRegistration
        at: number
    }
    | {type: 'error', error: unknown, at: number}

export type ModuleIsolationSession = {
    control: {
        start: () => Promise<void>
        terminate: (reason?: string) => Promise<void>
    }
    resource: {
        call: <T>(method: string, input: unknown, opts: ModuleIsolationCallOptions) => Promise<T>
    }
    events: {
        on: (cb: (event: tModuleIsolationEvent) => void) => (() => void)
    }
    view: {
        snapshot: () => {
            state: string
            methods: readonly string[]
            failure: {code: string, message: string} | null
        } & Record<string, unknown>
    }
    health: {
        snapshot: () => {
            health: string
            inFlight: number
        } & Record<string, unknown>
    }
    mcp: {
        control: {
            setPublished: (registrationId: number, attached: boolean, reason?: string) => boolean
        }
        resource: {
            call: <T>(registrationId: number, input: unknown, opts: ModuleIsolationCallOptions) => Promise<T>
        }
        events: {
            on: (cb: (event: Extract<tModuleIsolationEvent, {type: 'mcp'}>) => void) => (() => void)
        }
        view: {
            snapshot: () => {
                enabled: boolean
                total: number
                accepted: number
                attached: number
                detached: number
                rejected: number
                removed: number
                registrations: readonly ModuleIsolationMcpRegistration[]
            }
        }
    }
}

export type ModuleIsolationOpenInput = {
    artifact: VerifiedModuleArtifact
    candidateId: string
    candidateGeneration: number
}

export type ModuleIsolationPort = {
    resource: {
        open: (input: ModuleIsolationOpenInput) => ModuleIsolationSession | Promise<ModuleIsolationSession>
    }
}
