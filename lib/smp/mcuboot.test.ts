import { describe, expect, it } from "vitest"
import { parseMcubootImage } from "./mcuboot"

/** Build a minimal valid signed-image byte blob: 32-byte header + image body. */
function makeImage(options?: { magic?: number; truncate?: boolean }): Uint8Array {
  const headerSize = 0x200
  const imageSize = 64
  const total = headerSize + imageSize
  const bytes = new Uint8Array(options?.truncate ? headerSize : total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, options?.magic ?? 0x96f3b83d, true) // ih_magic
  view.setUint32(4, 0, true) // ih_load_addr
  view.setUint16(8, headerSize, true) // ih_hdr_size
  view.setUint16(10, 0, true) // ih_protect_tlv_size
  view.setUint32(12, imageSize, true) // ih_img_size
  view.setUint32(16, 0, true) // ih_flags
  view.setUint8(20, 1) // version major
  view.setUint8(21, 2) // version minor
  view.setUint16(22, 3, true) // version revision
  view.setUint32(24, 4, true) // version build number
  return bytes
}

describe("parseMcubootImage", () => {
  it("parses version and sizes from a valid header", () => {
    expect(parseMcubootImage(makeImage())).toEqual({
      version: "1.2.3+4",
      major: 1,
      minor: 2,
      revision: 3,
      build: 4,
      headerSize: 0x200,
      imageSize: 64,
    })
  })

  it("rejects a file with the wrong magic (e.g. an unsigned zephyr.bin)", () => {
    expect(() => parseMcubootImage(makeImage({ magic: 0xdeadbeef }))).toThrow(/signed MCUboot/)
  })

  it("rejects a file shorter than header + image size", () => {
    expect(() => parseMcubootImage(makeImage({ truncate: true }))).toThrow(/[Tt]runcated/)
  })

  it("rejects tiny files", () => {
    expect(() => parseMcubootImage(new Uint8Array(8))).toThrow(/too short/)
  })
})
