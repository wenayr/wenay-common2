import type { tServiceDefinition } from './definition';
declare const serviceType: unique symbol;
export type ServiceClientDefinition<D extends tServiceDefinition<any, any>> = {
    name: string;
    views: Record<string, {
        allow: 'public' | readonly string[];
    }>;
    commands: Record<string, null>;
    resources?: Record<string, {
        allow: readonly string[];
        placement: 'authority';
    }>;
    readonly [serviceType]: D;
};
export declare function describeService<D extends tServiceDefinition<any, any>>(definition: D): ServiceClientDefinition<D>;
export {};
