/**
 * MCUboot signed-image header validation (all fields little-endian).
 *
 * Guards the DFU flow against the classic mistake of picking `zephyr.bin`
 * instead of `zephyr.signed.bin` — only the signed image carries this header
 * (magic 0x96f3b83d) and only it will pass MCUboot's boot-time signature check.
 * A wrong image flashed to a board means wired J-Link recovery (no rollback in
 * overwrite-only mode), so this is the cheap local safety net.
 */

const MCUBOOT_MAGIC = 0x96f3b83d
const HEADER_BYTES = 32

export interface McubootImageInfo {
  /** Human-readable "major.minor.revision+build". */
  version: string
  major: number
  minor: number
  revision: number
  build: number
  headerSize: number
  imageSize: number
}

export function parseMcubootImage(fileBytes: Uint8Array): McubootImageInfo {
  if (fileBytes.length < HEADER_BYTES) {
    throw new Error("File is too short to be a firmware image")
  }
  const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength)
  if (view.getUint32(0, true) !== MCUBOOT_MAGIC) {
    throw new Error(
      "Not a signed MCUboot image (bad magic) — pick zephyr.signed.bin, not zephyr.bin",
    )
  }
  const headerSize = view.getUint16(8, true)
  const imageSize = view.getUint32(12, true)
  const major = view.getUint8(20)
  const minor = view.getUint8(21)
  const revision = view.getUint16(22, true)
  const build = view.getUint32(24, true)
  if (fileBytes.length < headerSize + imageSize) {
    throw new Error("Truncated image file (shorter than its header claims)")
  }
  return {
    version: `${major}.${minor}.${revision}+${build}`,
    major,
    minor,
    revision,
    build,
    headerSize,
    imageSize,
  }
}
