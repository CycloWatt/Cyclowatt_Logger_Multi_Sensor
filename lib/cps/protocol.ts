/**
 * The Cycling Power Service Control Point, as far as this bench needs it.
 *
 * Zero-offset calibration is not a CycloWatt invention: it is the SIG's own
 * "Start Offset Compensation" procedure, which is why a head unit can trigger it
 * with no knowledge of this firmware. The website drives the identical procedure
 * over the identical characteristic, so the two paths cannot drift apart.
 *
 * Everything here is pure so it can be unit-tested - this repo has no component
 * test setup, so behaviour worth pinning has to live in lib/ (same reasoning as
 * lib/dfu-status.ts). The GATT round trip itself is in ./calibration.
 *
 * Values are fixed by the firmware in src/services/cps_service.c; the comments
 * name the line that owns each one so a firmware change can be traced here.
 */

/** Cycling Power Service, 0x1818. Must be in optionalServices to be reachable. */
export const CPS_SERVICE_UUID = "00001818-0000-1000-8000-00805f9b34fb"

/** Cycling Power Feature, 0x2A65. Read-only uint32 of capability bits. */
export const CPS_FEATURE_CHAR_UUID = "00002a65-0000-1000-8000-00805f9b34fb"

/** Cycling Power Control Point, 0x2A66. Write + Indicate. */
export const CPS_CONTROL_POINT_CHAR_UUID = "00002a66-0000-1000-8000-00805f9b34fb"

/**
 * Feature bit 9, "Offset Compensation Supported" (cps_service.c:123).
 *
 * Worth checking rather than assuming: it is the board's own declaration that the
 * procedure exists, so a board running an image from before calibration landed
 * says so itself instead of failing an opaque write.
 */
export const CPS_FEATURE_OFFSET_COMPENSATION_BIT = 9

/** Start Offset Compensation (cps_service.c:94). */
export const CPS_OPCODE_START_OFFSET_COMPENSATION = 0x0c

/** Response Code, the opcode every answer starts with (cps_service.c:98). */
export const CPS_OPCODE_RESPONSE_CODE = 0x20

/* Response codes (cps_service.c:100-103). */
export const CPS_RESPONSE_SUCCESS = 0x01
export const CPS_RESPONSE_OPCODE_NOT_SUPPORTED = 0x02
export const CPS_RESPONSE_INVALID_OPERAND = 0x03
export const CPS_RESPONSE_OPERATION_FAILED = 0x04

/**
 * The command to start a calibration.
 *
 * Exactly one byte. The firmware length-checks this and answers INVALID_OPERAND
 * for anything else (cps_service.c:631), so padding it would fail rather than be
 * ignored.
 */
export function startOffsetCompensationCommand(): Uint8Array<ArrayBuffer> {
  /*
   * Built over an explicitly plain ArrayBuffer, and typed as such. Since
   * TypeScript 5.7 a bare Uint8Array is generic over ArrayBufferLike, which
   * includes SharedArrayBuffer and therefore does NOT satisfy the BufferSource
   * that writeValueWithResponse() takes.
   */
  const command = new Uint8Array(new ArrayBuffer(1))
  command[0] = CPS_OPCODE_START_OFFSET_COMPENSATION
  return command
}

/**
 * The Feature characteristic's capability word.
 *
 * UNSIGNED on purpose: the field is a uint32 and this firmware sets bit 20, so a
 * signed read would go negative as soon as a future image sets bit 31 and every
 * bit test above it would silently invert.
 */
export function readFeatureBits(value: DataView): number {
  return value.getUint32(0, true)
}

/** Does this board declare the offset-compensation procedure? */
export function offsetCompensationSupported(featureBits: number): boolean {
  return (featureBits & (1 << CPS_FEATURE_OFFSET_COMPENSATION_BIT)) !== 0
}

export interface ControlPointResponse {
  /** Which procedure this answers. Callers MUST filter on it - see ./calibration. */
  requestOpcode: number
  responseCode: number
  /** The 16-bit parameter, or null when the response carried none. */
  parameter: number | null
}

/**
 * Decode a Control Point indication, or null if this is not one.
 *
 * Null rather than a throw because indications arrive on a shared characteristic
 * and an unrecognised payload is a thing to skip, not an error to surface.
 *
 * The parameter is read SIGNED: the offset is an int16 in Newtons
 * (cps_service.c:866) and a real tare can be negative, which an unsigned read
 * would render as a plausible-looking number about 65536 too large.
 */
export function parseControlPointResponse(value: DataView): ControlPointResponse | null {
  if (value.byteLength < 3) return null
  if (value.getUint8(0) !== CPS_OPCODE_RESPONSE_CODE) return null
  return {
    requestOpcode: value.getUint8(1),
    responseCode: value.getUint8(2),
    parameter: value.byteLength >= 5 ? value.getInt16(3, true) : null,
  }
}

/** A response code as bench-readable text. */
export function describeResponseCode(code: number): string {
  switch (code) {
    case CPS_RESPONSE_SUCCESS:
      return "success"
    case CPS_RESPONSE_OPCODE_NOT_SUPPORTED:
      return "opcode not supported by this firmware"
    case CPS_RESPONSE_INVALID_OPERAND:
      return "invalid operand"
    case CPS_RESPONSE_OPERATION_FAILED:
      return "operation failed on the board (the sample window did not complete)"
    default:
      // Never render as "undefined": a future firmware code still has to be
      // reportable, and the raw value is what makes it greppable in cps_service.c.
      return `unknown response code 0x${code.toString(16).toUpperCase().padStart(2, "0")}`
  }
}
