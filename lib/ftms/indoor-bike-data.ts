/**
 * Indoor Bike Data (FTMS v1.0 §4.9), the Kickr's live speed / cadence / power
 * stream. It arrives at roughly 1-4 Hz for the life of a session, so this
 * parser has to be both correct and cheap - the reason it is a pure function
 * with no allocation beyond the returned object.
 *
 * The payload is flag-conditional: a uint16 LE flags word at offset 0, then
 * only the fields whose bit is set, each at whatever offset the PRECEDING
 * present fields pushed it to. Every FTMS client gets this wrong at least
 * once - a field silently shifts when an earlier optional field is present or
 * absent - which is why the fields are walked in one pass, in ascending bit
 * order, with a running offset, rather than each field computing its own
 * offset independently.
 *
 * Bit 0 is the one inversion in the whole layout: the SIG spec calls it "More
 * Data", and it means "instantaneous speed is NOT in this packet" when SET.
 * So speed is present when bit 0 is CLEAR - every other field is present when
 * its own bit is SET.
 *
 * Two fields the spec defines are parsed past but not exposed: expended
 * energy (bit 8, 5 bytes) and metabolic equivalent (bit 10, 1 byte). Nothing
 * on this bench consumes them, but their bytes still have to be walked over
 * or every field after them reads from the wrong offset.
 */

export interface IndoorBikeData {
  /** uint16, 0.01 km/h. Present when flag bit 0 ("More Data") is CLEAR. */
  speedKmh: number | null
  /** Bit 1, uint16, 0.01 km/h. */
  averageSpeedKmh: number | null
  /** Bit 2, uint16, 0.5 rpm. */
  cadenceRpm: number | null
  /** Bit 3, uint16, 0.5 rpm. */
  averageCadenceRpm: number | null
  /** Bit 4, uint24, metres. */
  totalDistanceM: number | null
  /** Bit 5, int16, unitless. */
  resistanceLevel: number | null
  /** Bit 6, int16, watts. */
  powerW: number | null
  /** Bit 7, int16, watts. */
  averagePowerW: number | null
  /** Bit 9, uint8, bpm. */
  heartRateBpm: number | null
  /** Bit 11, uint16, seconds. */
  elapsedS: number | null
  /** Bit 12, uint16, seconds. */
  remainingS: number | null
}

/** Flag bits, in the order the fields they gate appear on the wire. */
const FLAG_MORE_DATA_BIT = 0
const FLAG_AVERAGE_SPEED_BIT = 1
const FLAG_CADENCE_BIT = 2
const FLAG_AVERAGE_CADENCE_BIT = 3
const FLAG_TOTAL_DISTANCE_BIT = 4
const FLAG_RESISTANCE_LEVEL_BIT = 5
const FLAG_POWER_BIT = 6
const FLAG_AVERAGE_POWER_BIT = 7
const FLAG_EXPENDED_ENERGY_BIT = 8
const FLAG_HEART_RATE_BIT = 9
const FLAG_METABOLIC_EQUIVALENT_BIT = 10
const FLAG_ELAPSED_TIME_BIT = 11
const FLAG_REMAINING_TIME_BIT = 12

const bitSet = (flags: number, bit: number): boolean => (flags & (1 << bit)) !== 0

/**
 * Thrown internally when a flagged field runs off the end of the buffer, and
 * caught at the bottom of parseIndoorBikeData. An exception (rather than a
 * sentinel threaded through every helper) is what lets a single `offset += n`
 * cursor be shared across a dozen differently-shaped reads without every one
 * of them re-deriving "did the caller already give up".
 */
class TruncatedPayload extends Error {}

/**
 * Walks the flag-conditional fields in spec order, returning null the moment
 * the buffer runs out before a field its own flags claim it carries. Null
 * rather than a throw to the caller: a notification is a stream, and one
 * short packet is a frame to drop, not a reason to tear down the
 * characteristic listener.
 */
export function parseIndoorBikeData(view: DataView): IndoorBikeData | null {
  if (view.byteLength < 2) return null

  const flags = view.getUint16(0, true)
  let offset = 2

  const need = (bytes: number): void => {
    if (offset + bytes > view.byteLength) throw new TruncatedPayload()
  }

  /** uint16 LE scaled by `scale`, or null when the flag bit is clear. */
  const readScaledU16 = (present: boolean, scale: number): number | null => {
    if (!present) return null
    need(2)
    const raw = view.getUint16(offset, true)
    offset += 2
    return raw * scale
  }

  /** int16 LE, unscaled, or null when the flag bit is clear. */
  const readI16 = (present: boolean): number | null => {
    if (!present) return null
    need(2)
    const raw = view.getInt16(offset, true)
    offset += 2
    return raw
  }

  /** uint16 LE, unscaled, or null when the flag bit is clear. */
  const readU16 = (present: boolean): number | null => {
    if (!present) return null
    need(2)
    const raw = view.getUint16(offset, true)
    offset += 2
    return raw
  }

  try {
    // Bit 0 is inverted: speed rides along by default and is withdrawn ("More
    // Data") only when the sender is queuing more than one Indoor Bike Data
    // payload behind this notification.
    const speedKmh = readScaledU16(!bitSet(flags, FLAG_MORE_DATA_BIT), 0.01)
    const averageSpeedKmh = readScaledU16(bitSet(flags, FLAG_AVERAGE_SPEED_BIT), 0.01)
    const cadenceRpm = readScaledU16(bitSet(flags, FLAG_CADENCE_BIT), 0.5)
    const averageCadenceRpm = readScaledU16(bitSet(flags, FLAG_AVERAGE_CADENCE_BIT), 0.5)

    let totalDistanceM: number | null = null
    if (bitSet(flags, FLAG_TOTAL_DISTANCE_BIT)) {
      need(3)
      // No DataView.getUint24: three bytes, little-endian, assembled by hand.
      totalDistanceM = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
      offset += 3
    }

    const resistanceLevel = readI16(bitSet(flags, FLAG_RESISTANCE_LEVEL_BIT))
    const powerW = readI16(bitSet(flags, FLAG_POWER_BIT))
    const averagePowerW = readI16(bitSet(flags, FLAG_AVERAGE_POWER_BIT))

    // Expended energy: uint16 total kcal + uint16 kcal/h + uint8 kcal/min.
    // Nothing on the bench reads it, but the 5 bytes still gate everything
    // after them.
    if (bitSet(flags, FLAG_EXPENDED_ENERGY_BIT)) {
      need(5)
      offset += 5
    }

    let heartRateBpm: number | null = null
    if (bitSet(flags, FLAG_HEART_RATE_BIT)) {
      need(1)
      heartRateBpm = view.getUint8(offset)
      offset += 1
    }

    // Metabolic equivalent: uint8, 0.1 resolution. Consumed, not exposed.
    if (bitSet(flags, FLAG_METABOLIC_EQUIVALENT_BIT)) {
      need(1)
      offset += 1
    }

    const elapsedS = readU16(bitSet(flags, FLAG_ELAPSED_TIME_BIT))
    const remainingS = readU16(bitSet(flags, FLAG_REMAINING_TIME_BIT))

    return {
      speedKmh,
      averageSpeedKmh,
      cadenceRpm,
      averageCadenceRpm,
      totalDistanceM,
      resistanceLevel,
      powerW,
      averagePowerW,
      heartRateBpm,
      elapsedS,
      remainingS,
    }
  } catch (error) {
    if (error instanceof TruncatedPayload) return null
    throw error
  }
}
