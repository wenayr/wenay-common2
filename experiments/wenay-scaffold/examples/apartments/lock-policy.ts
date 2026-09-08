import type {LockCommand} from './service'

export const LOCK_UNLOCK_TTL_MS = 60_000

type LockCommandTiming = Pick<LockCommand, 'kind' | 'ts' | 'expiresAt'>

/** Legacy unlocks retain a short lifetime; legacy setCode needs the booking deadline from the server. */
export function lockCommandExpiresAt(command: LockCommandTiming) {
    if (!Number.isFinite(command.ts)) return undefined
    if (command.expiresAt != undefined && !Number.isFinite(command.expiresAt)) return undefined
    if (command.kind == 'unlock') return Math.min(command.ts + LOCK_UNLOCK_TTL_MS, command.expiresAt ?? Infinity)
    if (command.kind == 'setCode') return command.expiresAt
    if (command.kind == 'clearCode') return command.expiresAt ?? Infinity
    return undefined
}

export function lockCommandIsCurrent(command: LockCommandTiming, now = Date.now()) {
    const expiresAt = lockCommandExpiresAt(command)
    return Number.isFinite(now) && expiresAt != undefined && now < expiresAt
}
