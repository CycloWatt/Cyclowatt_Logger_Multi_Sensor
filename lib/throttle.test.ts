import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createThrottle } from "./throttle"

/** The deps every case shares: real fake-timer clock, node timers. */
const deps = (onFlush: (nowMs: number) => void, intervalMs = 200) => ({
  intervalMs,
  now: Date.now,
  setTimer: setTimeout,
  clearTimer: (handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  onFlush,
})

describe("createThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("flushes immediately on the first queue(), because lastFlush starts at 0", () => {
    const onFlush = vi.fn()
    createThrottle(deps(onFlush)).queue()

    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("hands the flush the clock reading it recorded as the new lastFlush", () => {
    const onFlush = vi.fn()
    vi.setSystemTime(1_700_000_000_000)
    createThrottle(deps(onFlush)).queue()

    expect(onFlush).toHaveBeenCalledWith(1_700_000_000_000)
  })

  it("collapses a burst inside the window into exactly one deferred flush", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle(deps(onFlush))

    throttle.queue() // immediate, lastFlush = now
    onFlush.mockClear()

    vi.advanceTimersByTime(50)
    for (let i = 0; i < 6; i++) throttle.queue()
    // Still inside the 200 ms window: nothing flushed, one timer pending.
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200) // the timer scheduled at t=50 fires at t=250
    expect(onFlush).toHaveBeenCalledTimes(1)

    // And nothing more once the burst has drained.
    vi.advanceTimersByTime(1000)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("treats the deferred flush's time as the new lastFlush", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle(deps(onFlush))

    throttle.queue() // immediate flush at t=0
    vi.advanceTimersByTime(50)
    throttle.queue() // deferred, scheduled at t=50, fires at t=250
    vi.advanceTimersByTime(200)
    onFlush.mockClear()

    vi.advanceTimersByTime(250) // t=500, past lastFlush(250) + 200
    throttle.queue()
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("cancel() drops a pending deferred flush", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle(deps(onFlush))

    throttle.queue() // immediate flush at t=0
    onFlush.mockClear()

    vi.advanceTimersByTime(50)
    throttle.queue() // deferred, would fire at t=250
    throttle.cancel()

    vi.advanceTimersByTime(500)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it("cancel() on an idle throttle is a no-op, and queueing still works after it", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle(deps(onFlush))

    expect(() => throttle.cancel()).not.toThrow()
    throttle.queue()
    expect(onFlush).toHaveBeenCalledTimes(1)
  })
})
