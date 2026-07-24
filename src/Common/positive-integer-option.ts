export function positiveIntegerOption(value: number | undefined, fallback: number, label: string) {
    const next = Math.floor(value ?? fallback)
    if (!Number.isFinite(next) || next <= 0) throw new RangeError(`${label} must be > 0`)
    return next
}
