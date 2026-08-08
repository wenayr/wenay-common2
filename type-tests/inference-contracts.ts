import {clone, deepClone} from '../src/Common/core/common'
import {createMemoryReplayStorage} from '../src/Common/events/replay-history'
import type {ReplayEvent} from '../src/Common/events/replay-listen'
import {openFsReplayStorage} from '../src/server/fsReplayStorage'

// The clone primitive is the source of the public inference. Both names must
// preserve the caller's exact type instead of widening the result to any.
const source = {kind: 'source' as const, nested: {value: 1}}
const cloneResult = clone(source)
const deepCloneResult = deepClone(source)
const cloneKind: 'source' = cloneResult.kind
const deepCloneKind: 'source' = deepCloneResult.kind

// @ts-expect-error clone(source) is the source object type, not any
const cloneCannotBecomeString: string = cloneResult
// @ts-expect-error deepClone(source) is the source object type, not any
const deepCloneCannotBecomeString: string = deepCloneResult

// Factory return types are derived from the implementations. Empty storage has
// no keyframe, so both implementations must carry undefined in that return type.
type tMemoryReplayStorage = ReturnType<typeof createMemoryReplayStorage<[number]>>
type tFsReplayStorage = ReturnType<typeof openFsReplayStorage<[number]>>
declare const memoryStorage: tMemoryReplayStorage
declare const fsStorage: tFsReplayStorage

const memoryKeyframe: ReplayEvent<[number]> | undefined = memoryStorage.getKeyframe()
const fsKeyframe: ReplayEvent<[number]> | undefined = fsStorage.getKeyframe()

// @ts-expect-error an empty memory storage can return undefined
const memoryKeyframeRequired: ReplayEvent<[number]> = memoryStorage.getKeyframe()
// @ts-expect-error an empty file storage can return undefined
const fsKeyframeRequired: ReplayEvent<[number]> = fsStorage.getKeyframe()

void cloneKind
void deepCloneKind
void cloneCannotBecomeString
void deepCloneCannotBecomeString
void memoryKeyframe
void fsKeyframe
void memoryKeyframeRequired
void fsKeyframeRequired
