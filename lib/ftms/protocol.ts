/**
 * The Bluetooth Fitness Machine Service (FTMS, 0x1826), as far as a trainer
 * bench needs it: the constants, the Control Point commands the panel sends, and
 * the decoders for what the trainer answers and reports.
 *
 * Everything here is pure so it can be unit-tested - the same reasoning as
 * lib/cps/protocol.ts, and deliberately the same file shape, so the two
 * control-point stacks read alike. The GATT round trips live in ./control; the
 * one large notification parser (Indoor Bike Data) has its own file.
 *
 * Values are the SIG's, from FTMS v1.0. Wahoo Kickr (v5+), Kickr Core and Snap
 * implement this standard service, which is why one implementation drives them
 * all without a Wahoo-specific protocol.
 */

import { CPS_SERVICE_UUID } from "../cps/protocol"

/** Fitness Machine Service, 0x1826. Must be in optionalServices to be reachable. */
export const FTMS_SERVICE_UUID = "00001826-0000-1000-8000-00805f9b34fb"

/** Fitness Machine Feature, 0x2ACC. Read-only, two uint32 capability words. */
export const FTMS_FEATURE_CHAR_UUID = "00002acc-0000-1000-8000-00805f9b34fb"

/** Indoor Bike Data, 0x2AD2. Notify; the live speed / cadence / power stream. */
export const FTMS_INDOOR_BIKE_DATA_CHAR_UUID = "00002ad2-0000-1000-8000-00805f9b34fb"

/** Supported Resistance Level Range, 0x2AD6. Read-only, optional. */
export const FTMS_SUPPORTED_RESISTANCE_RANGE_CHAR_UUID = "00002ad6-0000-1000-8000-00805f9b34fb"

/** Supported Power Range, 0x2AD8. Read-only, optional. */
export const FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID = "00002ad8-0000-1000-8000-00805f9b34fb"

/** Fitness Machine Control Point, 0x2AD9. Write + Indicate. */
export const FTMS_CONTROL_POINT_CHAR_UUID = "00002ad9-0000-1000-8000-00805f9b34fb"

/** Fitness Machine Status, 0x2ADA. Notify; the trainer's own view of what changed. */
export const FTMS_MACHINE_STATUS_CHAR_UUID = "00002ada-0000-1000-8000-00805f9b34fb"

/**
 * Every service the trainer chooser must declare up front.
 *
 * Chrome binds the set of reachable services to the grant made at
 * requestDevice() time; a service left out here is a SecurityError for the life
 * of that grant, and the only cure is re-picking the device. So the list names
 * everything the panel might read later, not only what it needs today: cycling
 * power (the Kickr also speaks CPS), battery, and GAP for the real device name.
 */
export const FTMS_OPTIONAL_SERVICES: readonly string[] = [
  FTMS_SERVICE_UUID,
  CPS_SERVICE_UUID,
  "battery_service",
  "generic_access",
]

/** Control Point opcodes (FTMS v1.0 §4.16.1). */
export const FTMS_OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_RESISTANCE: 0x04,
  SET_TARGET_POWER: 0x05,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
  /** The opcode every answer starts with. */
  RESPONSE_CODE: 0x80,
} as const

/** Parameter of Stop or Pause. */
export const FTMS_STOP_PARAM = {
  STOP: 0x01,
  PAUSE: 0x02,
} as const

export type FtmsStopParam = (typeof FTMS_STOP_PARAM)[keyof typeof FTMS_STOP_PARAM]

/** Control Point result codes (FTMS v1.0 §4.16.2.22). */
export const FTMS_RESULT = {
  SUCCESS: 0x01,
  NOT_SUPPORTED: 0x02,
  INVALID_PARAMETER: 0x03,
  OPERATION_FAILED: 0x04,
  CONTROL_NOT_PERMITTED: 0x05,
} as const

/** Fitness Machine Status opcodes (FTMS v1.0 §4.17). */
export const FTMS_STATUS_OP = {
  RESET: 0x01,
  STOPPED_OR_PAUSED: 0x02,
  STOPPED_SAFETY_KEY: 0x03,
  STARTED_OR_RESUMED: 0x04,
  TARGET_RESISTANCE_CHANGED: 0x07,
  TARGET_POWER_CHANGED: 0x08,
  CONTROL_PERMISSION_LOST: 0xff,
} as const

/* Fitness Machine Feature bits. */
const MACHINE_FEATURE_CADENCE_BIT = 1
const MACHINE_FEATURE_POWER_MEASUREMENT_BIT = 14
const TARGET_FEATURE_RESISTANCE_BIT = 2
const TARGET_FEATURE_POWER_BIT = 3

export interface FtmsFeatures {
  /** Machine features bit 1: the trainer measures cadence itself. */
  cadenceSupported: boolean
  /** Machine features bit 14: the trainer measures power itself. */
  powerMeasurementSupported: boolean
  /** Target-setting features bit 2: Set Target Resistance Level is accepted. */
  resistanceTargetSupported: boolean
  /** Target-setting features bit 3: Set Target Power (ERG mode) is accepted. */
  powerTargetSupported: boolean
  /** Both words, unsigned, for the console and the PR checklist. */
  raw: { machine: number; targetSetting: number }
}

/**
 * Decode the Feature characteristic: two uint32 LE words.
 *
 * UNSIGNED on purpose, as in lib/cps/protocol.ts: a signed read goes negative
 * the moment bit 31 is set and every bit test silently inverts. Throws on a
 * short payload because a trainer that cannot even report its features is not
 * one to drive blind; the session catches this and falls back to "unknown".
 */
export function parseFitnessMachineFeature(value: DataView): FtmsFeatures {
  if (value.byteLength < 8) {
    throw new Error(`Fitness Machine Feature is ${value.byteLength} bytes, expected 8`)
  }
  const machine = value.getUint32(0, true)
  const targetSetting = value.getUint32(4, true)
  const bit = (word: number, n: number) => (word & (1 << n)) !== 0
  return {
    cadenceSupported: bit(machine, MACHINE_FEATURE_CADENCE_BIT),
    powerMeasurementSupported: bit(machine, MACHINE_FEATURE_POWER_MEASUREMENT_BIT),
    resistanceTargetSupported: bit(targetSetting, TARGET_FEATURE_RESISTANCE_BIT),
    powerTargetSupported: bit(targetSetting, TARGET_FEATURE_POWER_BIT),
    raw: { machine, targetSetting },
  }
}

/** A min/max/increment triple as the trainer publishes it. Units per parser. */
export interface SupportedRange {
  min: number
  max: number
  increment: number
}

/** Supported Power Range: int16 min W, int16 max W, uint16 increment W. */
export function parseSupportedPowerRange(value: DataView): SupportedRange {
  return {
    min: value.getInt16(0, true),
    max: value.getInt16(2, true),
    increment: value.getUint16(4, true),
  }
}

/**
 * Supported Resistance Level Range: int16 min, int16 max, uint16 increment, all
 * in raw TENTHS of the unitless resistance level (resolution 0.1). Left in tenths
 * so it matches the byte Set Target Resistance Level carries.
 */
export function parseSupportedResistanceRange(value: DataView): SupportedRange {
  return {
    min: value.getInt16(0, true),
    max: value.getInt16(2, true),
    increment: value.getUint16(4, true),
  }
}

/** Used when the trainer does not publish 0x2AD8. Wide enough for any bench test. */
export const DEFAULT_POWER_RANGE: SupportedRange = { min: 0, max: 2000, increment: 1 }

/** Used when the trainer does not publish 0x2AD6. In tenths: 0 to 100.0. */
export const DEFAULT_RESISTANCE_RANGE: SupportedRange = { min: 0, max: 1000, increment: 10 }

/**
 * Snap a value onto the trainer's grid and clamp it into its range.
 *
 * The grid starts at `min`, as the spec defines it, so a range of 10..400 by 5
 * accepts 15 but not 12. An increment of 0 means "any value" and skips snapping
 * rather than dividing by it.
 */
export function clampToRange(value: number, range: SupportedRange): number {
  const snapped =
    range.increment > 0 ? range.min + Math.round((value - range.min) / range.increment) * range.increment : value
  return Math.min(range.max, Math.max(range.min, snapped))
}

/*
 * Every command is built over an explicitly plain ArrayBuffer and typed as such:
 * since TypeScript 5.7 a bare Uint8Array may sit on a SharedArrayBuffer, which
 * writeValueWithResponse()'s BufferSource does not accept (see lib/cps/protocol.ts).
 */
function command(length: number, fill: (view: DataView) => void): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(length)
  fill(new DataView(buffer))
  return new Uint8Array(buffer)
}

/** Request Control: must succeed before the trainer accepts any target. */
export function requestControlCommand(): Uint8Array<ArrayBuffer> {
  return command(1, (v) => v.setUint8(0, FTMS_OP.REQUEST_CONTROL))
}

/** Reset: the trainer drops its targets and releases control. */
export function resetCommand(): Uint8Array<ArrayBuffer> {
  return command(1, (v) => v.setUint8(0, FTMS_OP.RESET))
}

/** Set Target Power (ERG mode): int16 watts, little-endian. Rounded to whole watts. */
export function setTargetPowerCommand(watts: number): Uint8Array<ArrayBuffer> {
  return command(3, (v) => {
    v.setUint8(0, FTMS_OP.SET_TARGET_POWER)
    v.setInt16(1, Math.round(watts), true)
  })
}

/**
 * Set Target Resistance Level: ONE uint8 in tenths (so 25.5 is the ceiling the
 * wire can express), even though the Supported Resistance Level Range is int16.
 * A value that does not fit is a RangeError here rather than a silent wrap that
 * would set a random resistance under a rider.
 */
export function setTargetResistanceCommand(tenths: number): Uint8Array<ArrayBuffer> {
  const rounded = Math.round(tenths)
  if (rounded < 0 || rounded > 0xff) {
    throw new RangeError(`Target resistance ${tenths} tenths does not fit the uint8 the wire carries (0..255)`)
  }
  return command(2, (v) => {
    v.setUint8(0, FTMS_OP.SET_TARGET_RESISTANCE)
    v.setUint8(1, rounded)
  })
}

/** Start or Resume: the Kickr applies ERG targets only once this has been sent. */
export function startResumeCommand(): Uint8Array<ArrayBuffer> {
  return command(1, (v) => v.setUint8(0, FTMS_OP.START_RESUME))
}

/** Stop or Pause, with the parameter saying which. */
export function stopPauseCommand(param: FtmsStopParam): Uint8Array<ArrayBuffer> {
  return command(2, (v) => {
    v.setUint8(0, FTMS_OP.STOP_PAUSE)
    v.setUint8(1, param)
  })
}

export interface FtmsControlResponse {
  /** Which command this answers. Callers MUST filter on it - see ./control. */
  requestOpcode: number
  resultCode: number
}

/**
 * Decode a Control Point indication, or null if this is not one.
 *
 * Null rather than a throw: indications arrive on a shared characteristic and
 * an unrecognised payload is a thing to skip. Anything beyond the third byte is
 * a response parameter (some opcodes carry one) and is ignored here.
 */
export function parseControlPointResponse(value: DataView): FtmsControlResponse | null {
  if (value.byteLength < 3) return null
  if (value.getUint8(0) !== FTMS_OP.RESPONSE_CODE) return null
  return { requestOpcode: value.getUint8(1), resultCode: value.getUint8(2) }
}

export type FtmsStatus =
  | { kind: "reset" }
  | { kind: "stoppedOrPaused"; param: number }
  | { kind: "stoppedSafetyKey" }
  | { kind: "startedOrResumed" }
  | { kind: "targetPowerChanged"; watts: number }
  | { kind: "targetResistanceChanged"; tenths: number }
  | { kind: "controlPermissionLost" }
  | { kind: "other"; opcode: number }

/**
 * Decode a Fitness Machine Status notification, or null for an empty or
 * truncated one. Unknown opcodes stay reportable as `other` so a trainer doing
 * something this bench has not seen still shows up in the session log.
 */
export function parseMachineStatus(value: DataView): FtmsStatus | null {
  if (value.byteLength < 1) return null
  const opcode = value.getUint8(0)
  switch (opcode) {
    case FTMS_STATUS_OP.RESET:
      return { kind: "reset" }
    case FTMS_STATUS_OP.STOPPED_OR_PAUSED:
      if (value.byteLength < 2) return null
      return { kind: "stoppedOrPaused", param: value.getUint8(1) }
    case FTMS_STATUS_OP.STOPPED_SAFETY_KEY:
      return { kind: "stoppedSafetyKey" }
    case FTMS_STATUS_OP.STARTED_OR_RESUMED:
      return { kind: "startedOrResumed" }
    case FTMS_STATUS_OP.TARGET_RESISTANCE_CHANGED:
      if (value.byteLength < 2) return null
      return { kind: "targetResistanceChanged", tenths: value.getUint8(1) }
    case FTMS_STATUS_OP.TARGET_POWER_CHANGED:
      if (value.byteLength < 3) return null
      return { kind: "targetPowerChanged", watts: value.getInt16(1, true) }
    case FTMS_STATUS_OP.CONTROL_PERMISSION_LOST:
      return { kind: "controlPermissionLost" }
    default:
      return { kind: "other", opcode }
  }
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`

/** A result code as bench-readable text. */
export function describeResultCode(code: number): string {
  switch (code) {
    case FTMS_RESULT.SUCCESS:
      return "success"
    case FTMS_RESULT.NOT_SUPPORTED:
      return "opcode not supported by this trainer"
    case FTMS_RESULT.INVALID_PARAMETER:
      return "invalid parameter (outside the trainer's supported range)"
    case FTMS_RESULT.OPERATION_FAILED:
      return "operation failed on the trainer"
    case FTMS_RESULT.CONTROL_NOT_PERMITTED:
      return "control not permitted (Request Control first, or another app holds it)"
    default:
      // Never "undefined": the raw value is what makes a new code greppable.
      return `unknown result code ${hex(code)}`
  }
}

/** A Control Point opcode by its spec name, for log lines and error text. */
export function describeOpcode(opcode: number): string {
  switch (opcode) {
    case FTMS_OP.REQUEST_CONTROL:
      return "Request Control"
    case FTMS_OP.RESET:
      return "Reset"
    case FTMS_OP.SET_TARGET_RESISTANCE:
      return "Set Target Resistance Level"
    case FTMS_OP.SET_TARGET_POWER:
      return "Set Target Power"
    case FTMS_OP.START_RESUME:
      return "Start or Resume"
    case FTMS_OP.STOP_PAUSE:
      return "Stop or Pause"
    default:
      return `opcode ${hex(opcode)}`
  }
}
