/**
 * The leading + trailing throttle behind the Trainer tab's display flush.
 *
 * Bike-data notifications can arrive many times a second; a human reading the
 * panel cannot, so `queueDisplayUpdate`/`flushDisplay` throttled every state
 * write to at most once per DISPLAY_FLUSH_MS. That logic lived inline in
 * components/trainer-panel.tsx, coupled to `Date.now`/`setTimeout` and two
 * refs - here it is the same state machine over injected clock/timer
 * functions, so it is unit-testable with `vi.useFakeTimers()` in plain node.
 *
 * Leading + trailing, not just trailing: the FIRST update in a quiet period
 * shows up immediately (lastFlush starts at 0, so `now - last >= interval`
 * is true) rather than waiting a quarter second to show data that already
 * arrived. Everything after that, within one window, collapses to a single
 * deferred flush at the window boundary - a burst of `queue()` calls between
 * flushes must still leave exactly one pending timer, not one per call.
 */

export interface ThrottleDeps {
  intervalMs: number
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  onFlush: (nowMs: number) => void
}

export function createThrottle(deps: ThrottleDeps): { queue(): void; cancel(): void } {
  const { intervalMs, now, setTimer, clearTimer, onFlush } = deps
  let last = 0
  let timer: unknown = null

  function queue(): void {
    if (now() - last >= intervalMs) {
      last = now()
      onFlush(last)
    } else if (timer === null) {
      timer = setTimer(() => {
        timer = null
        last = now()
        onFlush(last)
      }, intervalMs)
    }
  }

  function cancel(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return { queue, cancel }
}
