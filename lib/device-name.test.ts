import { describe, expect, it } from "vitest"
import { BOARD_NAME_PREFIXES, BOARD_NAME_PREFIX_HINT, firmwareVersionFromName } from "./device-name"

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
  ])("covers %s", (name) => expect(BOARD_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))).toBe(true))

  it("does not match an unrelated device", () => {
    expect(BOARD_NAME_PREFIXES.some((prefix) => "Garmin Edge 530".startsWith(prefix))).toBe(false)
  })

  it("renders every prefix into the UI hint", () => {
    expect(BOARD_NAME_PREFIX_HINT).toBe("Cyclowatt..., CRaw..., CycloRaw...")
  })
})
