import { describe, expect, it } from "vitest"
import { BOARD_NAME_PREFIXES, BOARD_NAME_PREFIX_HINT, firmwareVersionFromName, isBoardName } from "./device-name"

describe("firmwareVersionFromName", () => {
  it.each([
    ["Cyclowatt L v0.2.2", "0.2.2"],
    ["Cyclowatt R v0.2.2", "0.2.2"],
    ["Cyclowatt v10.20.30", "10.20.30"],
    // Since v0.5.0 a per-board tag sits between base and version. The match is
    // end-anchored, so the tag is irrelevant to it - this pins that.
    ["Cyclowatt L A3F1 v0.6.0", "0.6.0"],
    ["CRaw L A3F1 v0.6.0", "0.6.0"],
    ["CRaw 00FF v0.6.0", "0.6.0"],
  ])("extracts from %s", (name, version) => expect(firmwareVersionFromName(name)).toBe(version))

  it.each([
    ["CycloRaw"],
    ["Cyclowatt L"],
    [""],
    [null],
    [undefined],
    ["v0.2.2suffix"],
    // A data-acquisition board's ADVERTISED name: 11 chars hold base + tag only,
    // so there is no version to stamp until the GAP name is read post-connect.
    ["CRaw L A3F1"],
  ])("returns null for %s", (name) => expect(firmwareVersionFromName(name as string | null | undefined)).toBeNull())
})

describe("BOARD_NAME_PREFIXES", () => {
  // Every base the firmware can put on air, across both images and both naming
  // eras. A prefix list that misses one of these strands that board in the
  // chooser - which is exactly the regression this list exists to prevent.
  it.each([
    ["Cyclowatt L A3F1 v0.6.0"],
    ["Cyclowatt R A3F1 v0.6.0"],
    ["Cyclowatt A3F1 v0.6.0"],
    ["CRaw L A3F1"],
    ["CRaw R A3F1"],
    ["CRaw A3F1"],
    ["CycloRaw L"],
    ["CycloRaw R"],
    ["CycloRaw v0.4.0"],
    // Asserted THROUGH isBoardName rather than by repeating the startsWith here,
    // so this coverage guarantee and the runtime guard are the same code path and
    // cannot drift apart.
  ])("covers %s", (name) => expect(isBoardName(name)).toBe(true))

  it("does not match an unrelated device", () => {
    expect(isBoardName("Garmin Edge 530")).toBe(false)
  })

  it("renders every prefix into the UI hint", () => {
    expect(BOARD_NAME_PREFIX_HINT).toBe("Cyclowatt..., CRaw..., CycloRaw...")
  })
})

describe("isBoardName", () => {
  // The reference power-meter flow rejects on this predicate, so a false NEGATIVE
  // is the expensive direction: it puts a CycloWatt board back into an SRM-only
  // area. The coverage of every advertised base lives in the block above.

  it.each([
    // Real commercial meters, the devices the reference flow exists for. All of
    // these advertise the same Cycling Power service our boards do, which is why
    // the service filter cannot separate them and the name has to.
    ["SRM ORIGIN 12345"],
    ["Garmin Edge 530"],
    ["Quarq DZero"],
    ["Stages LR"],
    ["Favero Assioma"],
    [""],
  ])("does not claim %s", (name) => expect(isBoardName(name)).toBe(false))

  it("treats a missing name as not-ours rather than throwing", () => {
    // Web Bluetooth leaves `name` undefined for a device advertising no name at
    // all. Returning false is right: an unnamed device is not identifiably one of
    // ours, and the reference flow should let the user try it.
    expect(isBoardName(null)).toBe(false)
    expect(isBoardName(undefined)).toBe(false)
  })

  it("is prefix-anchored, not a substring match", () => {
    // "My Cyclowatt Clone" contains a base but does not start with one. Anchoring
    // matters in the other direction too: a substring match would reject a
    // legitimately-named reference meter that merely mentions the brand.
    expect(isBoardName("My Cyclowatt Clone")).toBe(false)
    expect(isBoardName("Not A CRaw Board")).toBe(false)
  })
})
