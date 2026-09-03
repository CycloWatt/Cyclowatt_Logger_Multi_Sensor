import { describe, expect, it } from "vitest"
import {
  DEFAULT_POWER_RANGE,
  DEFAULT_RESISTANCE_RANGE,
  FTMS_OP,
  FTMS_OPTIONAL_SERVICES,
  FTMS_RESULT,
  FTMS_SERVICE_UUID,
  FTMS_STOP_PARAM,
  clampToRange,
  describeOpcode,
  describeResultCode,
  parseControlPointResponse,
  parseFitnessMachineFeature,
  parseMachineStatus,
  parseSupportedPowerRange,
  parseSupportedResistanceRange,
  requestControlCommand,
  resetCommand,
  setTargetPowerCommand,
  setTargetResistanceCommand,
  startResumeCommand,
  stopPauseCommand,
} from "./protocol"
import { CPS_SERVICE_UUID } from "../cps/protocol"

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)
const bytes = (u8: Uint8Array) => Array.from(u8)

describe("UUIDs", () => {
  it("names the Fitness Machine Service", () => {
    expect(FTMS_SERVICE_UUID).toBe("00001826-0000-1000-8000-00805f9b34fb")
  })

  it("lists every service the panel may touch later, FTMS first", () => {
    expect(FTMS_OPTIONAL_SERVICES[0]).toBe(FTMS_SERVICE_UUID)
    expect(FTMS_OPTIONAL_SERVICES).toContain(CPS_SERVICE_UUID)
    expect(FTMS_OPTIONAL_SERVICES).toContain("battery_service")
    expect(FTMS_OPTIONAL_SERVICES).toContain("generic_access")
  })
})

describe("command encoders", () => {
  it("encodes single-byte commands", () => {
    expect(bytes(requestControlCommand())).toEqual([FTMS_OP.REQUEST_CONTROL])
    expect(bytes(resetCommand())).toEqual([FTMS_OP.RESET])
    expect(bytes(startResumeCommand())).toEqual([FTMS_OP.START_RESUME])
  })

  it("encodes target power as opcode 0x05 plus a little-endian int16", () => {
    expect(bytes(setTargetPowerCommand(250))).toEqual([0x05, 0xfa, 0x00])
  })

  it("encodes a negative target power in two's complement", () => {
    expect(bytes(setTargetPowerCommand(-1))).toEqual([0x05, 0xff, 0xff])
  })

  it("rounds a fractional target power to whole watts", () => {
    expect(bytes(setTargetPowerCommand(199.6))).toEqual([0x05, 0xc8, 0x00])
  })

  it("encodes target resistance as opcode 0x04 plus one byte of tenths", () => {
    expect(bytes(setTargetResistanceCommand(125))).toEqual([0x04, 0x7d])
    expect(bytes(setTargetResistanceCommand(255))).toEqual([0x04, 0xff])
  })

  it("refuses a resistance outside the uint8 the wire carries", () => {
    expect(() => setTargetResistanceCommand(256)).toThrow(RangeError)
    expect(() => setTargetResistanceCommand(-1)).toThrow(RangeError)
  })

  it("encodes stop and pause as opcode 0x08 plus the parameter", () => {
    expect(bytes(stopPauseCommand(FTMS_STOP_PARAM.STOP))).toEqual([0x08, 0x01])
    expect(bytes(stopPauseCommand(FTMS_STOP_PARAM.PAUSE))).toEqual([0x08, 0x02])
  })

  it("builds every command over a plain ArrayBuffer (BufferSource for writeValueWithResponse)", () => {
    expect(setTargetPowerCommand(100).buffer).toBeInstanceOf(ArrayBuffer)
  })
})

describe("parseFitnessMachineFeature", () => {
  it("reads the machine and target-setting words independently", () => {
    // machine: bit 1 (cadence) + bit 14 (power measurement); target: bit 2 + bit 3
    const features = parseFitnessMachineFeature(view(0x02, 0x40, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00))
    expect(features.cadenceSupported).toBe(true)
    expect(features.powerMeasurementSupported).toBe(true)
    expect(features.resistanceTargetSupported).toBe(true)
    expect(features.powerTargetSupported).toBe(true)
    expect(features.raw).toEqual({ machine: 0x4002, targetSetting: 0x0c })
  })

  it("reports absent bits as false", () => {
    const features = parseFitnessMachineFeature(view(0, 0, 0, 0, 0x08, 0, 0, 0))
    expect(features.cadenceSupported).toBe(false)
    expect(features.powerMeasurementSupported).toBe(false)
    expect(features.resistanceTargetSupported).toBe(false)
    expect(features.powerTargetSupported).toBe(true)
  })

  it("reads the words unsigned so bit 31 cannot flip the tests below it", () => {
    const features = parseFitnessMachineFeature(view(0x02, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80))
    expect(features.raw.machine).toBe(0x80000002)
    expect(features.cadenceSupported).toBe(true)
  })

  it("throws on a payload shorter than the two words", () => {
    expect(() => parseFitnessMachineFeature(view(1, 2, 3, 4))).toThrow()
  })
})

describe("supported ranges", () => {
  it("reads the power range as int16 min/max and uint16 increment", () => {
    expect(parseSupportedPowerRange(view(0x00, 0x00, 0xd0, 0x07, 0x01, 0x00))).toEqual({
      min: 0,
      max: 2000,
      increment: 1,
    })
  })

  it("keeps a negative minimum signed", () => {
    expect(parseSupportedPowerRange(view(0xf6, 0xff, 0x10, 0x27, 0x05, 0x00)).min).toBe(-10)
  })

  it("reads the resistance range in raw tenths", () => {
    expect(parseSupportedResistanceRange(view(0x00, 0x00, 0xe8, 0x03, 0x0a, 0x00))).toEqual({
      min: 0,
      max: 1000,
      increment: 10,
    })
  })

  it("names the short payload in the error rather than throwing a bare RangeError", () => {
    // readOptional turns either throw into the spec default; the message is what
    // makes "trainer sent a truncated range" greppable in the console.
    expect(() => parseSupportedPowerRange(view(0x00, 0x00, 0xd0, 0x07))).toThrow(/4 bytes, expected 6/)
    expect(() => parseSupportedResistanceRange(view(0x00, 0x00))).toThrow(/2 bytes, expected 6/)
  })

  it("provides sane defaults for a trainer that does not publish a range", () => {
    expect(DEFAULT_POWER_RANGE).toEqual({ min: 0, max: 2000, increment: 1 })
    expect(DEFAULT_RESISTANCE_RANGE).toEqual({ min: 0, max: 1000, increment: 10 })
  })
})

describe("clampToRange", () => {
  const range = { min: 10, max: 400, increment: 5 }

  it("passes through a value already on the grid", () => {
    expect(clampToRange(200, range)).toBe(200)
  })

  it("snaps to the nearest increment counted from min", () => {
    expect(clampToRange(202, range)).toBe(200)
    expect(clampToRange(203, range)).toBe(205)
  })

  it("clamps below and above", () => {
    expect(clampToRange(-50, range)).toBe(10)
    expect(clampToRange(5000, range)).toBe(400)
  })

  it("does not snap when the increment is zero", () => {
    expect(clampToRange(123, { min: 0, max: 1000, increment: 0 })).toBe(123)
  })
})

describe("parseControlPointResponse", () => {
  it("decodes a three-byte response", () => {
    expect(parseControlPointResponse(view(0x80, 0x05, 0x01))).toEqual({ requestOpcode: 0x05, resultCode: 0x01 })
  })

  it("accepts a response with trailing parameter bytes", () => {
    expect(parseControlPointResponse(view(0x80, 0x00, 0x05, 0x00, 0x00))).toEqual({
      requestOpcode: 0x00,
      resultCode: FTMS_RESULT.CONTROL_NOT_PERMITTED,
    })
  })

  it("returns null for anything that is not a response code", () => {
    expect(parseControlPointResponse(view(0x05, 0xfa, 0x00))).toBeNull()
    expect(parseControlPointResponse(view(0x80, 0x05))).toBeNull()
    expect(parseControlPointResponse(view())).toBeNull()
  })
})

describe("parseMachineStatus", () => {
  it("decodes control permission lost", () => {
    expect(parseMachineStatus(view(0xff))).toEqual({ kind: "controlPermissionLost" })
  })

  it("decodes a target power change with a signed watt value", () => {
    expect(parseMachineStatus(view(0x08, 0xfa, 0x00))).toEqual({ kind: "targetPowerChanged", watts: 250 })
    expect(parseMachineStatus(view(0x08, 0xff, 0xff))).toEqual({ kind: "targetPowerChanged", watts: -1 })
  })

  it("decodes a target resistance change in tenths", () => {
    expect(parseMachineStatus(view(0x07, 0x32))).toEqual({ kind: "targetResistanceChanged", tenths: 50 })
  })

  it("decodes start, stop and reset", () => {
    expect(parseMachineStatus(view(0x04))).toEqual({ kind: "startedOrResumed" })
    expect(parseMachineStatus(view(0x02, 0x02))).toEqual({ kind: "stoppedOrPaused", param: 2 })
    expect(parseMachineStatus(view(0x03))).toEqual({ kind: "stoppedSafetyKey" })
    expect(parseMachineStatus(view(0x01))).toEqual({ kind: "reset" })
  })

  it("keeps an unknown opcode reportable", () => {
    expect(parseMachineStatus(view(0x12, 0x00))).toEqual({ kind: "other", opcode: 0x12 })
  })

  it("returns null for an empty payload or a truncated parameter", () => {
    expect(parseMachineStatus(view())).toBeNull()
    expect(parseMachineStatus(view(0x08, 0xfa))).toBeNull()
  })
})

describe("descriptions", () => {
  it("names every result code", () => {
    expect(describeResultCode(FTMS_RESULT.SUCCESS)).toBe("success")
    expect(describeResultCode(FTMS_RESULT.NOT_SUPPORTED)).toMatch(/not supported/)
    expect(describeResultCode(FTMS_RESULT.INVALID_PARAMETER)).toMatch(/invalid parameter/)
    expect(describeResultCode(FTMS_RESULT.OPERATION_FAILED)).toMatch(/operation failed/)
    expect(describeResultCode(FTMS_RESULT.CONTROL_NOT_PERMITTED)).toMatch(/control not permitted/)
  })

  it("falls back to the raw hex for an unknown code or opcode", () => {
    expect(describeResultCode(0x7b)).toBe("unknown result code 0x7B")
    expect(describeOpcode(0x7b)).toBe("opcode 0x7B")
  })

  it("names the opcodes the panel sends", () => {
    expect(describeOpcode(FTMS_OP.REQUEST_CONTROL)).toBe("Request Control")
    expect(describeOpcode(FTMS_OP.SET_TARGET_POWER)).toBe("Set Target Power")
    expect(describeOpcode(FTMS_OP.SET_TARGET_RESISTANCE)).toBe("Set Target Resistance Level")
    expect(describeOpcode(FTMS_OP.START_RESUME)).toBe("Start or Resume")
    expect(describeOpcode(FTMS_OP.STOP_PAUSE)).toBe("Stop or Pause")
    expect(describeOpcode(FTMS_OP.RESET)).toBe("Reset")
  })
})
