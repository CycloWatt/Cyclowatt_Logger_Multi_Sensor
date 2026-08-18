import { describe, expect, it } from "vitest"
import { applyDeviceName, nextDisplayName } from "./device-list"

describe("nextDisplayName", () => {
  it("adopts a genuine rename", () => {
    // The everyday bench case: a flash bumped the version suffix, and the board
    // itself reported the new name post-connect.
    expect(nextDisplayName("Cyclowatt L A3F1 v0.5.0", "Cyclowatt L A3F1 v0.6.0", "gap")).toBe(
      "Cyclowatt L A3F1 v0.6.0",
    )
  })

  it("adopts a rename seen only in an advertisement", () => {
    // No connection needed: a prod image's on-air name carries the version, so a
    // reflashed board corrects its row without anyone connecting to it.
    expect(
      nextDisplayName("Cyclowatt L A3F1 v0.5.0", "Cyclowatt L A3F1 v0.6.2", "advertisement"),
    ).toBe("Cyclowatt L A3F1 v0.6.2")
  })

  it("keeps the fuller name when an advertisement is only a truncation of it", () => {
    // A data-acquisition image spends its 11-character on-air name budget on the
    // base plus the per-board tag, clipping the version away. Adopting that would
    // silently drop the version from a row that already knew it.
    expect(nextDisplayName("CRaw L B2C3 v0.6.2", "CRaw L B2C3", "advertisement")).toBe(
      "CRaw L B2C3 v0.6.2",
    )
  })

  it("lets an authoritative GAP read shorten the name", () => {
    // The prefix guard is about truncated ADVERTISEMENTS. A 0x2A00 read is the
    // full string the firmware set, so if it is shorter, the name really is.
    expect(nextDisplayName("CRaw L B2C3 v0.6.2", "CRaw L B2C3", "gap")).toBe("CRaw L B2C3")
  })

  it("ignores an empty or absent candidate", () => {
    // A blank row identifies nothing; a stale one at least identifies the board.
    expect(nextDisplayName("CRaw L B2C3", "", "gap")).toBe("CRaw L B2C3")
    expect(nextDisplayName("CRaw L B2C3", null, "advertisement")).toBe("CRaw L B2C3")
    expect(nextDisplayName("CRaw L B2C3", undefined, "gap")).toBe("CRaw L B2C3")
  })

  it("treats an identical candidate as no change", () => {
    expect(nextDisplayName("CRaw L B2C3", "CRaw L B2C3", "advertisement")).toBe("CRaw L B2C3")
  })

  it("replaces the placeholder given to a nameless grant", () => {
    expect(nextDisplayName("Unknown Device", "CRaw L B2C3", "advertisement")).toBe("CRaw L B2C3")
  })
})

describe("applyDeviceName", () => {
  it("updates only the row whose id matches", () => {
    const other = { id: "b", name: "Cyclowatt R 0F00 v0.6.0" }
    const entries = [{ id: "a", name: "Cyclowatt L A3F1 v0.5.0" }, other]
    const result = applyDeviceName(entries, "a", "Cyclowatt L A3F1 v0.6.0", "gap")
    expect(result[0].name).toBe("Cyclowatt L A3F1 v0.6.0")
    // The untouched row keeps its object identity, so memoized children below it
    // do not re-render.
    expect(result[1]).toBe(other)
  })

  it("carries unrelated fields across the update", () => {
    // The helper must not strip a row down to the fields it happens to know about.
    const entries = [{ id: "a", name: "CRaw L B2C3 v0.5.0", hasTargetService: true, remembered: true }]
    const result = applyDeviceName(entries, "a", "CRaw L B2C3 v0.6.0", "gap")
    expect(result[0]).toEqual({
      id: "a",
      name: "CRaw L B2C3 v0.6.0",
      hasTargetService: true,
      remembered: true,
    })
  })

  it("returns the SAME array when nothing changed", () => {
    // Identity preservation is load-bearing: this feeds a React state setter, and
    // same-reference means React skips the re-render. Advertisements repeat
    // several times a second, so a new-but-equal array would re-render that often.
    const entries = [{ id: "a", name: "Cyclowatt L A3F1 v0.6.0" }]
    expect(applyDeviceName(entries, "a", "Cyclowatt L A3F1 v0.6.0", "gap")).toBe(entries)
  })

  it("returns the SAME array when no id matches", () => {
    const entries = [{ id: "a", name: "Cyclowatt L A3F1 v0.6.0" }]
    expect(applyDeviceName(entries, "missing", "Something Else", "gap")).toBe(entries)
  })

  it("applies a patch alongside the name", () => {
    const entries = [{ id: "a", name: "CRaw L B2C3 v0.5.0", inRange: false }]
    const result = applyDeviceName(entries, "a", "CRaw L B2C3 v0.6.0", "gap", { inRange: true })
    expect(result[0]).toEqual({ id: "a", name: "CRaw L B2C3 v0.6.0", inRange: true })
  })

  it("applies a patch even when the name did not change", () => {
    // First advertisement from a board whose name was already right still has to
    // latch the "(in range)" evidence.
    const entries = [{ id: "a", name: "CRaw L B2C3", inRange: false }]
    const result = applyDeviceName(entries, "a", "CRaw L B2C3", "advertisement", { inRange: true })
    expect(result).not.toBe(entries)
    expect(result[0].inRange).toBe(true)
  })

  it("returns the SAME array once the patch is already satisfied", () => {
    // The repeat-advertisement steady state: name right, inRange already latched.
    const entries = [{ id: "a", name: "CRaw L B2C3", inRange: true }]
    expect(applyDeviceName(entries, "a", "CRaw L B2C3", "advertisement", { inRange: true })).toBe(
      entries,
    )
  })

  it("handles an empty list", () => {
    const entries: { id: string; name: string }[] = []
    expect(applyDeviceName(entries, "a", "CRaw L B2C3", "gap")).toBe(entries)
  })

  it("lets a later advertisement correct a name an authoritative read had set", () => {
    // Freshness beats authority when the two disagree, because the board can be
    // reflashed between the two observations: a 0x2A00 read said v0.6.0, then the
    // board was flashed and now advertises v0.6.2. Tiering the sources so a "gap"
    // read outranked everything afterwards would re-freeze the row - the same
    // failure mode as trusting BluetoothDevice.name, just slower to appear.
    const entries = [{ id: "a", name: "Cyclowatt L A3F1 v0.6.0" }]
    const result = applyDeviceName(entries, "a", "Cyclowatt L A3F1 v0.6.2", "advertisement")
    expect(result[0].name).toBe("Cyclowatt L A3F1 v0.6.2")
  })
})
