import { describe, expect, it } from "vitest"
import { cborDecode, cborEncode, type CborValue } from "./cbor"

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
const fromHex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16))

// Reference vectors from RFC 8949 Appendix A (the CBOR spec's own test table).
const VECTORS: Array<[CborValue, string]> = [
  [0, "00"],
  [10, "0a"],
  [23, "17"],
  [24, "1818"],
  [100, "1864"],
  [1000, "1903e8"],
  [1000000, "1a000f4240"],
  [-1, "20"],
  [-10, "29"],
  [-100, "3863"],
  [-1000, "3903e7"],
  ["", "60"],
  ["a", "6161"],
  ["IETF", "6449455446"],
  [Uint8Array.from([1, 2, 3, 4]), "4401020304"],
  [[], "80"],
  [[1, 2, 3], "83010203"],
  [{}, "a0"],
  [{ a: 1, b: [2, 3] }, "a26161016162820203"],
  [false, "f4"],
  [true, "f5"],
  [null, "f6"],
]

describe("cborEncode", () => {
  it.each(VECTORS)("encodes %j", (value, expected) => {
    expect(hex(cborEncode(value))).toBe(expected)
  })

  it("uses a 2-byte length for byte strings of 256+ bytes", () => {
    const data = new Uint8Array(300).fill(0xab)
    const encoded = cborEncode(data)
    // 0x59 = bytes with uint16 length; 0x012c = 300
    expect(hex(encoded.subarray(0, 3))).toBe("59012c")
    expect(encoded.length).toBe(3 + 300)
  })

  it("rejects non-integer numbers", () => {
    expect(() => cborEncode(1.5)).toThrow(/integer/)
  })
})

describe("cborDecode", () => {
  it.each(VECTORS)("decodes to %j", (value, encoded) => {
    expect(cborDecode(fromHex(encoded))).toEqual(value)
  })

  it("round-trips an SMP-shaped upload request", () => {
    const request: CborValue = {
      image: 0,
      len: 318000,
      off: 0,
      sha: new Uint8Array(32).fill(7),
      data: Uint8Array.from({ length: 200 }, (_, i) => i % 251),
    }
    expect(cborDecode(cborEncode(request))).toEqual(request)
  })

  it("rejects trailing bytes", () => {
    expect(() => cborDecode(fromHex("0000"))).toThrow(/trailing/)
  })

  it("rejects truncated input", () => {
    expect(() => cborDecode(fromHex("6449455446".slice(0, 6)))).toThrow(/end of input/)
  })

  // Zephyr's zcbor encoder (non-canonical, the firmware default) opens every SMP
  // response map/array as an indefinite-length item closed by a 0xff break byte —
  // the decoder must accept those. Vectors from RFC 8949 Appendix A plus an
  // SMP-shaped echo response.
  const INDEFINITE_VECTORS: Array<[string, CborValue]> = [
    ["9fff", []],
    ["bfff", {}],
    ["9f018202039f0405ffff", [1, [2, 3], [4, 5]]],
    ["bf61610161629f0203ffff", { a: 1, b: [2, 3] }],
    ["bf61726568656c6c6fff", { r: "hello" }],
  ]

  it.each(INDEFINITE_VECTORS)("decodes indefinite-length %s", (encoded, value) => {
    expect(cborDecode(fromHex(encoded))).toEqual(value)
  })

  it("rejects indefinite-length text strings (zcbor never chunks strings)", () => {
    // (_ "strea", "ming") — RFC 8949 Appendix A
    expect(() => cborDecode(fromHex("7f657374726561646d696e67ff"))).toThrow(/unsupported/)
  })

  it("rejects indefinite-length byte strings (zcbor never chunks strings)", () => {
    // (_ h'0102', h'030405') — RFC 8949 Appendix A
    expect(() => cborDecode(fromHex("5f42010243030405ff"))).toThrow(/unsupported/)
  })

  it("rejects a break byte outside an indefinite-length item", () => {
    expect(() => cborDecode(fromHex("ff"))).toThrow(/break/)
  })

  it("rejects an unterminated indefinite-length map", () => {
    expect(() => cborDecode(fromHex("bf616101"))).toThrow(/end of input/)
  })

  it("rejects floats (not in the SMP subset)", () => {
    expect(() => cborDecode(fromHex("f93c00"))).toThrow(/unsupported/)
  })

  it("rejects tags (not in the SMP subset)", () => {
    expect(() => cborDecode(fromHex("c000"))).toThrow(/unsupported/)
  })

  it("rejects 64-bit integers beyond Number.MAX_SAFE_INTEGER", () => {
    expect(() => cborDecode(fromHex("1b0020000000000000"))).toThrow(/safe integer/)
  })
})
