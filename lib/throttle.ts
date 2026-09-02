/**
 * The leading + trailing display throttle both tabs run on.
 *
 * Two inputs push far faster than a human reads: the raw-stream serial
 * synchronization line (a value per line, hundreds/s) and the Trainer tab's
 * bike-data notifications. Both collapsed their React state writes with the
 * same inline state machine over `Date.now`/`setTimeout` and a pair of refs -
 * this is that machine with the clock and the timer injected, so it can be
 * unit-tested with `vi.useFakeTimers()` in the node-only vitest setup, and so
 * the two copies cannot drift apart.
 *
 * Leading AND trailing, not just trailing: the first value after a quiet spell
 * must show up at once (`last` starts at 0, so the window test passes on the
 * very first `queue()`), while everything inside one window collapses to a
 * SINGLE deferred flush at the window boundary - so the last value of a burst
 * still lands on screen, and a burst of n calls leaves one pending timer, not n.
 *
 * `cancel()` exists for teardown: a deferred flush that fires after the input
 * was disconnected would resurrect the stale value the disconnect just zeroed.
 */

export interface ThrottleDeps {
  intervalMs: number
  now: () => number
  /** Returns an opaque handle; `unknown` so both `setTimeout` flavours fit. */
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Receives the clock reading recorded as the new `last`. */
  onFlush: (nowMs: number) => void
}

export interface Throttle {
  queue(): void
  cancel(): void
}

export function createThrottle(deps: ThrottleDeps): Throttle {
  const { intervalMs, now, setTimer, clearTimer, onFlush } = deps
  let last = 0
  let timer: unknown = null

  function queue(): void {
    const current = now()
    if (current - last >= intervalMs) {
      last = current
      onFlush(current)
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
