import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createThrottle } from "./display-throttle"

describe("createThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("flushes immediately on the first queue(), since lastFlush starts at 0", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle({
      intervalMs: 250,
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      onFlush,
    })

    throttle.queue()

    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("schedules exactly one deferred flush at +250ms for a burst inside the window", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle({
      intervalMs: 250,
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      onFlush,
    })

    throttle.queue() // immediate flush, lastFlush = 0
    onFlush.mockClear()

    vi.advanceTimersByTime(50)
    throttle.queue()
    throttle.queue()
    throttle.queue()
    throttle.queue()
    throttle.queue()
    throttle.queue()
    // Still within the window: no flush yet, only one timer pending.
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250) // the deferred timer, scheduled at t=50, fires at t=300
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("treats the deferred flush's time as the new lastFlush, so a queue() 300ms later flushes immediately", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle({
      intervalMs: 250,
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      onFlush,
    })

    throttle.queue() // immediate flush at t=0
    onFlush.mockClear()

    vi.advanceTimersByTime(50)
    throttle.queue() // deferred, scheduled at t=50, fires at t=300
    vi.advanceTimersByTime(250)
    expect(onFlush).toHaveBeenCalledTimes(1)
    onFlush.mockClear()

    vi.advanceTimersByTime(300) // now t=600, well past lastFlush(300)+250
    throttle.queue()
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it("cancel() drops a pending deferred flush", () => {
    const onFlush = vi.fn()
    const throttle = createThrottle({
      intervalMs: 250,
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      onFlush,
    })

    throttle.queue() // immediate flush at t=0
    onFlush.mockClear()

    vi.advanceTimersByTime(50)
    throttle.queue() // deferred, scheduled at t=50, would fire at t=300
    throttle.cancel()

    vi.advanceTimersByTime(500)
    expect(onFlush).not.toHaveBeenCalled()
  })
})
