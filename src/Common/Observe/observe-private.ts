// Internal Observe metadata. Kept outside the public Observe facade.

export const REACTIVE_ARRAY_MUTATIONS = Symbol('reactive.arrayMutations')
export const STORE_REPLAY_PATCH_SOURCE = Symbol('store.replayPatchSource')

export type ReactiveArrayMutations = {
    paths: readonly PropertyKey[][]
    replacements: readonly PropertyKey[][]
}
