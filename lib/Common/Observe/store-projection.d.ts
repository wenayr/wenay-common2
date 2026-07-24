import { Store, StoreChange } from './store';
export declare function cloneStoreProjectionValue<T>(value: T): T;
export declare function reconcileStoreProjection<T extends object>(store: Store<T>, next: T): number;
export declare function collectStoreProjectionChanges(change: StoreChange, collections: readonly PropertyKey[]): Map<PropertyKey, Set<PropertyKey>> | null;
export declare function reconcileStoreProjectionRecord<T extends object>(store: Store<T>, collectionKey: PropertyKey, itemKey: PropertyKey, next: {
    exists: boolean;
    value?: unknown;
}): boolean;
