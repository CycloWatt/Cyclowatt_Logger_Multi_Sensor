/**
 * The standard Cycling Power Measurement characteristic (0x2A63), as far as this
 * bench needs it: just the instantaneous-power field.
 *
 * This deliberately ignores the flags word. The Bluetooth SIG spec uses those
 * flags to say which optional fields (pedal balance, torque, wheel/crank
 * revolutions, ...) follow instantaneous power, but a reference power meter is
 * only ever read here for its power number, and that field is mandatory and
 * fixed at offset 2 regardless of which optional fields trail it. A fuller
 * parser that needed to reach past instantaneous power into an optional field
 * would have to decode the flags first to know where that field starts; this
 * one never has to look, because it only ever wants the field at the front.
 */

/**
 * Read instantaneous power (sint16, watts, little-endian) from a Cycling Power
 * Measurement notification, or null if the payload is too short to contain it.
 *
 * Byte 0-1: flags (uint16, little-endian) - ignored, see module comment.
 * Byte 2-3: instantaneous power (sint16, watts, little-endian).
 */
export function parseCyclingPowerMeasurement(view: DataView): number | null {
  if (view.byteLength < 4) return null
  return view.getInt16(2, true)
}
