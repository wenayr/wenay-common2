import type { tServicePrincipal } from './definition';
export type ServiceResourceContext = {
    readonly principal: Readonly<tServicePrincipal>;
    readonly sessionId: string;
    readonly resourceId: string;
    readonly signal: AbortSignal;
};
export type ServiceResourceDefinition = {
    allow: readonly string[];
    placement: 'authority';
    open: (context: ServiceResourceContext) => {
        facade: object;
        close: () => void | Promise<void>;
    } | Promise<{
        facade: object;
        close: () => void | Promise<void>;
    }>;
};
export type ServiceResourceOptions = {
    openTimeoutMs?: number;
    closeTimeoutMs?: number;
};
export type ServiceResourceError = {
    code: string;
    message: string;
};
export type ServiceResourceStatus = {
    phase: 'opening' | 'ready' | 'offline' | 'denied' | 'failed' | 'closed';
    generation: number;
    error: ServiceResourceError | null;
};
export type ServiceResourceFacts = {
    revision: number;
    account: string | null;
    roles: readonly string[];
    allowed: string[];
};
