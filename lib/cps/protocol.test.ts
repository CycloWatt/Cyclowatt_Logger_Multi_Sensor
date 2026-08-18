import { describe, expect, it } from "vitest"
import {
  CPS_OPCODE_START_OFFSET_COMPENSATION,
  CPS_RESPONSE_INVALID_OPERAND,
  CPS_RESPONSE_OPCODE_NOT_SUPPORTED,
  CPS_RESPONSE_OPERATION_FAILED,
  CPS_RESPONSE_SUCCESS,
  describeResponseCode,
  offsetCompensationSupported,
  parseControlPointResponse,
  readFeatureBits,
  startOffsetCompensationCommand,
} from "./protocol"

/** A DataView over the given bytes, which is what a characteristic read hands back. */
const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

describe("startOffsetCompensationCommand", () => {
  it("is the single opcode byte and nothing else", () => {
    // The firmware rejects any other length as INVALID_OPERAND, so the length is
    // as load-bearing as the value.
    const command = startOffsetCompensationCommand()
    expect(Array.from(command)).toEqual([0x0c])
    expect(command).toBeInstanceOf(Uint8Array)
  })

  it("uses the opcode the firmware switches on", () => {
    expect(CPS_OPCODE_START_OFFSET_COMPENSATION).toBe(0x0c)
  })
})

describe("readFeatureBits", () => {
  it("reads the feature field as a little-endian uint32", () => {
    // Bit 9 alone = 0x00000200, which on the wire is 00 02 00 00.
    expect(readFeatureBits(view(0x00, 0x02, 0x00, 0x00))).toBe(0x200)
  })

  it("does not sign-extend a feature word with the top bit set", () => {
    // getInt32 here would yield a negative number and break every bit test above
    // bit 30.
    expect(readFeatureBits(view(0xff, 0xff, 0xff, 0xff))).toBe(0xffffffff)
  })
})

describe("offsetCompensationSupported", () => {
  it("accepts a feature word with bit 9 set", () => {
    expect(offsetCompensationSupported(1 << 9)).toBe(true)
  })

  it("accepts the real feature word this firmware advertises", () => {
    // Pedal power balance (0), crank revolution data (3), offset compensation (9),
    // crank length adjustment (12), distributed system not supported (20).
    const advertised = (1 << 0) | (1 << 3) | (1 << 9) | (1 << 12) | (1 << 20)
    expect(offsetCompensationSupported(advertised)).toBe(true)
  })

  it("rejects a feature word without bit 9", () => {
    // Neighbouring bits must not be mistaken for it.
    expect(offsetCompensationSupported((1 << 8) | (1 << 10))).toBe(false)
    expect(offsetCompensationSupported(0)).toBe(false)
  })
})

describe("parseControlPointResponse", () => {
  it("parses a success response and its offset parameter", () => {
    const parsed = parseControlPointResponse(view(0x20, 0x0c, 0x01, 0x2a, 0x00))
    expect(parsed).toEqual({ requestOpcode: 0x0c, responseCode: 0x01, parameter: 42 })
  })

  it("reads the offset as SIGNED", () => {
    // A tare can legitimately be negative, and getUint16 would report -3 N as
    // 65533 N - a plausible-looking number that is wrong by 65536.
    const parsed = parseControlPointResponse(view(0x20, 0x0c, 0x01, 0xfd, 0xff))
    expect(parsed?.parameter).toBe(-3)
  })

  it("reports a parameterless response as parameter null", () => {
    // Every failure path answers with three bytes and no parameter.
    const parsed = parseControlPointResponse(view(0x20, 0x0c, 0x04))
    expect(parsed).toEqual({ requestOpcode: 0x0c, responseCode: 0x04, parameter: null })
  })

  it("keeps the request opcode so a foreign procedure's answer is identifiable", () => {
    // Crank-length writes share this characteristic; the caller filters on this.
    const parsed = parseControlPointResponse(view(0x20, 0x04, 0x01))
    expect(parsed?.requestOpcode).toBe(0x04)
  })

  it("rejects a payload that is not a Response Code opcode", () => {
    expect(parseControlPointResponse(view(0x0c, 0x0c, 0x01))).toBeNull()
  })

  it("rejects a truncated payload", () => {
    expect(parseControlPointResponse(view(0x20, 0x0c))).toBeNull()
    expect(parseControlPointResponse(view())).toBeNull()
  })
})

describe("describeResponseCode", () => {
  it("names each code the firmware can return", () => {
    expect(describeResponseCode(CPS_RESPONSE_SUCCESS)).toMatch(/success/i)
    expect(describeResponseCode(CPS_RESPONSE_OPCODE_NOT_SUPPORTED)).toMatch(/not supported/i)
    expect(describeResponseCode(CPS_RESPONSE_INVALID_OPERAND)).toMatch(/operand/i)
    expect(describeResponseCode(CPS_RESPONSE_OPERATION_FAILED)).toMatch(/failed/i)
  })

  it("still says something useful for a code it does not know", () => {
    // Forward compatibility: a future firmware code must not render as "undefined".
    expect(describeResponseCode(0x7f)).toContain("0x7F")
  })
})
