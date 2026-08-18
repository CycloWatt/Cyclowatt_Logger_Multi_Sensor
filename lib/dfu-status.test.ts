import { describe, expect, it } from "vitest"
import { describeDfuActivity } from "./dfu-status"
import type { ImageSlotState } from "./smp/client"

function slot(over: Partial<ImageSlotState> = {}): ImageSlotState {
  return {
    slot: 0,
    version: "0.6.0",
    hash: new Uint8Array([1, 2, 3]),
    bootable: true,
    pending: false,
    confirmed: true,
    active: true,
    permanent: false,
    ...over,
  }
}

describe("describeDfuActivity", () => {
  it("reports the in-browser flash first, whatever the stale slots say", () => {
    // The listing is deliberately a settled one: an in-flight flash must win over
    // it, because the read button is disabled during a flash and those rows are
    // left over from before it started.
    const activity = describeDfuActivity([slot()], true)
    expect(activity.running).toBe(true)
    expect(activity.text).toContain("running in this browser")
  })

  it("says nothing at all before the first read", () => {
    // The distinction that matters: "I have no evidence" is not "no update is
    // running". Claiming the latter on an empty listing would be a lie the bench
    // could act on.
    expect(describeDfuActivity([], false)).toEqual({ running: false, text: "" })
  })

  it("reports a staged image as running", () => {
    const activity = describeDfuActivity([slot(), slot({ slot: 1, pending: true, active: false, confirmed: false, version: "0.7.0" })], false)
    expect(activity.running).toBe(true)
    expect(activity.text).toContain("Update staged")
    expect(activity.text).toContain("slot 1")
    expect(activity.text).toContain("0.7.0")
  })

  it("reports an unconfirmed running image as a trial", () => {
    const activity = describeDfuActivity([slot({ confirmed: false, version: "0.7.0" })], false)
    expect(activity.running).toBe(true)
    expect(activity.text).toContain("Update on trial")
    expect(activity.text).toContain("NOT confirmed")
    // The consequence is the whole point of showing it - a bench reader has to
    // know this board changes version on the next reset.
    expect(activity.text).toContain("reverts")
  })

  it("prefers the staged image over the trial when both are true", () => {
    // A board that took an update while already unconfirmed. Staged is the more
    // actionable of the two: it is what the NEXT boot does.
    const activity = describeDfuActivity(
      [slot({ confirmed: false }), slot({ slot: 1, pending: true, active: false, confirmed: false })],
      false,
    )
    expect(activity.text).toContain("Update staged")
  })

  it("reports a settled board as idle, naming what is running", () => {
    const activity = describeDfuActivity([slot({ version: "0.6.0" })], false)
    expect(activity.running).toBe(false)
    expect(activity.text).toContain("No firmware update in progress")
    expect(activity.text).toContain("0.6.0")
    expect(activity.text).toContain("confirmed")
  })

  it("does not describe a running image when no slot claims to be active", () => {
    // Defensive: a malformed or partial image list must not produce a confident
    // sentence about an image that was never identified.
    const activity = describeDfuActivity([slot({ active: false, confirmed: false })], false)
    expect(activity.running).toBe(false)
    expect(activity.text).toBe("No firmware update in progress.")
  })
})
