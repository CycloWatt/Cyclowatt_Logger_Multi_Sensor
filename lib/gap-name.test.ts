import { describe, expect, it, vi } from "vitest"
import { readGapDeviceName } from "./gap-name"

/** A connected device whose 0x2A00 read resolves to `bytes`. */
const deviceReading = (bytes: Uint8Array) => ({
  gatt: {
    connected: true,
    getPrimaryService: vi.fn(async () => ({
      getCharacteristic: vi.fn(async () => ({
        readValue: async () => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      })),
    })),
  },
})

const encode = (text: string) => new TextEncoder().encode(text)

describe("readGapDeviceName", () => {
  it("decodes the name the board reports", async () => {
    await expect(readGapDeviceName(deviceReading(encode("Cyclowatt L A3F1 v0.6.2")))).resolves.toBe(
      "Cyclowatt L A3F1 v0.6.2",
    )
  })

  it("asks for the GAP service and the device-name characteristic by their standard aliases", async () => {
    // Chrome resolves these aliases to 0x1800 / 0x2A00. Pinned here because
    // "generic_access" is also what every connect path must list in
    // optionalServices - the two spellings have to agree or the read is refused.
    const device = deviceReading(encode("CRaw L B2C3 v0.6.2"))
    await readGapDeviceName(device)
    expect(device.gatt.getPrimaryService).toHaveBeenCalledWith("generic_access")
    const service = await device.gatt.getPrimaryService.mock.results[0].value
    expect(service.getCharacteristic).toHaveBeenCalledWith("gap.device_name")
  })

  it("strips the NUL padding of a fixed-size attribute", async () => {
    // Padding would otherwise reach a CSV filename as invisible characters and
    // break equality against the advertised name for no visible reason.
    await expect(readGapDeviceName(deviceReading(encode("CRaw L B2C3\0\0\0")))).resolves.toBe(
      "CRaw L B2C3",
    )
  })

  it("returns null for a blank read", async () => {
    await expect(readGapDeviceName(deviceReading(encode("   ")))).resolves.toBeNull()
  })

  it("returns null when the link is down", async () => {
    // Nothing to read over - notably the case in a disconnect handler, which is
    // why the page does not try to refresh a name there.
    const getPrimaryService = vi.fn()
    await expect(
      readGapDeviceName({ gatt: { connected: false, getPrimaryService } }),
    ).resolves.toBeNull()
    expect(getPrimaryService).not.toHaveBeenCalled()
  })

  it("returns null for a device with no GATT at all", async () => {
    await expect(readGapDeviceName({ gatt: null })).resolves.toBeNull()
    await expect(readGapDeviceName({})).resolves.toBeNull()
    await expect(readGapDeviceName(null)).resolves.toBeNull()
  })

  it("returns null when the platform hides service 0x1800", async () => {
    await expect(
      readGapDeviceName({
        gatt: {
          connected: true,
          getPrimaryService: async () => {
            throw new DOMException("No Services matching UUID found.", "NotFoundError")
          },
        },
      }),
    ).resolves.toBeNull()
  })

  it("returns null when the grant predates generic_access in optionalServices", async () => {
    // Chrome's SecurityError for a service that was not declared at
    // requestDevice() time. Re-picking the device once through the chooser repairs
    // the grant; until then the row simply keeps the name it has.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(
        readGapDeviceName({
          gatt: {
            connected: true,
            getPrimaryService: async () => {
              throw new DOMException("Origin is not allowed to access the service.", "SecurityError")
            },
          },
        }),
      ).resolves.toBeNull()
      // The failure must be ANNOUNCED, not swallowed: a silent null leaves the old
      // name on screen and looks identical to the bug this module fixes. Asserted
      // so the diagnostic cannot rot into dead code.
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0][0]).toContain("SecurityError")
      expect(warn.mock.calls[0][0]).toContain("re-pick the board")
    } finally {
      warn.mockRestore()
    }
  })

  it("returns null when the characteristic read itself fails", async () => {
    await expect(
      readGapDeviceName({
        gatt: {
          connected: true,
          getPrimaryService: async () => ({
            getCharacteristic: async () => ({
              readValue: async () => {
                throw new DOMException("GATT operation failed for unknown reason.", "NotSupportedError")
              },
            }),
          }),
        },
      }),
    ).resolves.toBeNull()
  })
})
