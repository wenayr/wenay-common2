// Shared by RPC grants and service resource ownership; platform timers have a signed 32-bit limit.
export function createRpcDeadline(deps: {at: number, fire: () => void, unref?: boolean}) {
    const maxTimerMs = 2_147_483_647
    let timer: ReturnType<typeof setTimeout>
    function arm() {
        const remaining = deps.at - Date.now()
        timer = remaining > maxTimerMs ? setTimeout(arm, maxTimerMs) : setTimeout(deps.fire, Math.max(remaining, 0))
        if (deps.unref) (timer as any).unref?.()
    }
    arm()
    return {cancel() { clearTimeout(timer) }}
}
