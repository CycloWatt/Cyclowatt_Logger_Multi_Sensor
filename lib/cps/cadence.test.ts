import { describe, expect, it } from "vitest"
import { ReferenceCadence } from "./cadence"

function packet(revs: number, time: number, extras = false) {
  const offset = extras ? 13 : 4
  const view = new DataView(new ArrayBuffer(offset + 4))
  view.setUint16(0, extras ? 0x35 : 0x20, true)
  view.setUint16(offset, revs, true)
  view.setUint16(offset + 2, time, true)
  return view
}

describe("ReferenceCadence", () => {
  it("derives RPM after two events, skipping preceding optional fields", () => {
    const cadence = new ReferenceCadence()
    expect(cadence.update(packet(10, 100, true), 1000)).toBeNull()
    expect(cadence.update(packet(12, 2148, true), 3000)).toBe(60)
  })
  it("handles rollover of both uint16 counters", () => {
    const cadence = new ReferenceCadence()
    cadence.update(packet(65535, 65024), 1000)
    expect(cadence.update(packet(0, 512), 2000)).toBe(60)
  })
  it("holds duplicate events briefly then blanks stale data and resets on disconnect", () => {
    const cadence = new ReferenceCadence()
    cadence.update(packet(1, 0), 1000)
    cadence.update(packet(2, 1024), 2000)
    expect(cadence.update(packet(2, 1024), 3000)).toBe(60)
    expect(cadence.value(5001)).toBeNull()
    cadence.reset()
    expect(cadence.update(packet(9, 5000), 6000)).toBeNull()
  })
  it("blanks missing and truncated crank data", () => {
    const cadence = new ReferenceCadence()
    expect(cadence.update(new DataView(new ArrayBuffer(4)), 1000)).toBeNull()
    expect(cadence.update(new DataView(new Uint8Array([32, 0, 0, 0, 1]).buffer), 1000)).toBeNull()
  })
})

it("reacquires a baseline after a full event-clock period without movement", () => {
  const cadence = new ReferenceCadence()
  cadence.update(packet(1, 100), 1000)
  expect(cadence.update(packet(2, 1124), 2000)).toBe(60)
  expect(cadence.update(packet(3, 2148), 67000)).toBeNull()
  expect(cadence.update(packet(4, 3172), 68000)).toBe(60)
})

it("keeps crank history across power-only packets and expires missing updates", () => {
  const cadence = new ReferenceCadence()
  const powerOnly = new DataView(new ArrayBuffer(4))
  cadence.update(packet(1, 100), 1000)
  expect(cadence.update(powerOnly, 1500)).toBeNull()
  expect(cadence.update(packet(2, 1124), 2000)).toBe(60)
  expect(cadence.update(powerOnly, 2500)).toBe(60)
  expect(cadence.update(powerOnly, 5001)).toBeNull()
})
