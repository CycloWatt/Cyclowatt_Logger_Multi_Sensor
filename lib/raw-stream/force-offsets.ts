/**
 * The per-channel force zero offsets, read off the board after a calibration.
 *
 * A calibration measures all six channels but answers over the Cycling Power
 * Control Point, whose response carries exactly one value - so the standard
 * procedure can only ever report the average and the rest is discarded at the
 * answer. The board therefore ALSO serves the full set on a read-only vendor
 * characteristic, and this module reads it.
 *
 * BENCH ONLY BY DESIGN. The characteristic lives in the raw-stream service, which
 * only the data-acquisition image builds. A production board has no such service,
 * which is why an absent service resolves null here instead of rejecting: for a
 * customer board that is the expected outcome, not a failure.
 *
 * No grant change was needed for any of this: the raw-stream service UUID is
 * already listed in optionalServices on all three connect paths in app/page.tsx,
 * including firmware-update-only. Unlike the Cycling Power addition, an existing
 * grant reaches this characteristic without a re-pick through Scan.
 *
 * Everything is pure except the one GATT read, and that read is structurally
 * typed, so the whole flow is unit-testable without a Web Bluetooth environment
 * (the same approach as lib/cps/calibration.ts and lib/gap-name.ts).
 *
 * The layout is fixed by the firmware in src/services/force_offsets_wire.h.
 */

/** Raw-stream service, the data-acquisition-only vendor service. */
export const RAW_STREAM_SERVICE_UUID = "5a1d0001-c7a1-4b2e-9e4f-1a2b3c4d5e6f"

/** Force-calibration-offsets characteristic, read-only, 13 bytes. */
export const FORCE_OFFSETS_CHAR_UUID = "5a1d0004-c7a1-4b2e-9e4f-1a2b3c4d5e6f"

/** Packet length: one calibrated flag plus six little-endian int16 offsets. */
export const FORCE_OFFSETS_WIRE_LEN = 13

/** How many force channels the board reads. Matches SENSOR_SAMPLE_FORCE_COUNT. */
export const FORCE_CHANNEL_COUNT = 6

export interface ForceOffsetsReport {
  /**
   * Whether the board has a STORED calibration.
   *
   * Load-bearing rather than decorative: a never-calibrated board reports six
   * zeros, which is correct uncalibrated behaviour and indistinguishable on its
   * own from a genuine zero result. Without this flag the screen would present a
   * calibration that never ran.
   */
  calibrated: boolean
  /** The six per-channel zero offsets in millivolts, in board channel order. */
  offsetsMv: number[]
}

/**
 * Decode one packet, or null if it is too short to be one.
 *
 * Null rather than a throw for the same reason the Cycling Power decoder does it:
 * a payload that is not what we expect is a thing to skip, not an error to raise.
 *
 * Offsets are read SIGNED. A real tare can be negative, and an unsigned read would
 * render it about 65536 too high - a plausible-looking number, which is what makes
 * that mistake expensive.
 */
export function decodeForceOffsets(value: DataView): ForceOffsetsReport | null {
  if (value.byteLength < FORCE_OFFSETS_WIRE_LEN) return null

  const offsetsMv: number[] = []
  for (let channel = 0; channel < FORCE_CHANNEL_COUNT; channel++) {
    offsetsMv.push(value.getInt16(1 + channel * 2, true))
  }

  /*
   * Any non-zero flag counts as calibrated. The firmware sends exactly 1, but a
   * decoder accepting only 1 would silently report a future encoding as "never
   * calibrated" - the one wrong answer this field exists to prevent.
   */
  return { calibrated: value.getUint8(0) !== 0, offsetsMv }
}

/** The characteristic operation this flow uses. A real one satisfies it. */
export interface ForceOffsetsCharacteristic {
  readValue: () => Promise<DataView>
}

export interface ForceOffsetsService {
  getCharacteristic: (uuid: string) => Promise<ForceOffsetsCharacteristic>
}

export interface ForceOffsetsServer {
  getPrimaryService: (uuid: string) => Promise<ForceOffsetsService>
}

export interface ForceOffsetsDevice {
  gatt?:
    | (ForceOffsetsServer & { connected: boolean; connect: () => Promise<ForceOffsetsServer> })
    | null
}

/**
 * Read the board's stored per-channel offsets.
 *
 * @param device the connected board.
 * @returns the decoded report, or null when this board does not serve it - no
 *          device, no raw-stream service, or no such characteristic. Every OTHER
 *          failure rejects: swallowing them all as "must be a production board"
 *          would hide real breakage behind a plausible explanation.
 */
export async function readForceOffsets(
  device: ForceOffsetsDevice | null | undefined,
): Promise<ForceOffsetsReport | null> {
  const gatt = device?.gatt
  if (!gatt) return null

  try {
    const server = gatt.connected ? gatt : await gatt.connect()
    const service = await server.getPrimaryService(RAW_STREAM_SERVICE_UUID)
    const characteristic = await service.getCharacteristic(FORCE_OFFSETS_CHAR_UUID)

    return decodeForceOffsets(await characteristic.readValue())
  } catch (err) {
    /*
     * Chrome raises NotFoundError both for an absent service and an absent
     * characteristic, which is exactly the pair that means "this board does not
     * have the feature" - a production image, or a data-acquisition image from
     * before this characteristic landed.
     */
    if (err instanceof Error && err.name === "NotFoundError") return null
    throw err
  }
}
