import { describe, expect, it } from "vitest"
import { cborEncode } from "./cbor"
import {
  SMP_GROUP,
  SMP_HEADER_SIZE,
  SMP_OP,
  OS_CMD,
  SmpFrameAssembler,
  decodeHeader,
  encodeFrame,
} from "./packet"

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

describe("encodeFrame", () => {
  it("builds the canonical echo request frame", () => {
    // write(2) | flags 0 | len 9 (BE) | group 0 (BE) | seq 0 | cmd 0, then {d:"hello"}
    const payload = cborEncode({ d: "hello" })
    const frame = encodeFrame(
      { op: SMP_OP.WRITE, flags: 0, group: SMP_GROUP.OS, seq: 0, id: OS_CMD.ECHO },
      payload,
    )
    expect(hex(frame)).toBe("0200000900000000" + "a16164" + "6568656c6c6f")
  })

  it("writes length and group big-endian", () => {
    const frame = encodeFrame(
      { op: SMP_OP.WRITE, flags: 0, group: 0x0102, seq: 7, id: 1 },
      new Uint8Array(300),
    )
    expect(frame[2]).toBe(0x01) // len 300 = 0x012c
    expect(frame[3]).toBe(0x2c)
    expect(frame[4]).toBe(0x01)
    expect(frame[5]).toBe(0x02)
    expect(frame.length).toBe(SMP_HEADER_SIZE + 300)
  })
})

describe("decodeHeader", () => {
  it("decodes a write-response header", () => {
    const header = decodeHeader(Uint8Array.from([3, 0, 0, 2, 0, 1, 5, 1]))
    expect(header).toEqual({ op: SMP_OP.WRITE_RSP, flags: 0, length: 2, group: 1, seq: 5, id: 1 })
  })

  it("rejects short input", () => {
    expect(() => decodeHeader(new Uint8Array(7))).toThrow(/header/)
  })
})

describe("SmpFrameAssembler", () => {
  const frame = encodeFrame(
    { op: SMP_OP.WRITE_RSP, flags: 0, group: SMP_GROUP.IMAGE, seq: 9, id: 1 },
    cborEncode({ off: 4096 }),
  )

  it("reassembles a frame split across three notifications", () => {
    const assembler = new SmpFrameAssembler()
    expect(assembler.push(frame.subarray(0, 5))).toEqual([])
    expect(assembler.push(frame.subarray(5, 11))).toEqual([])
    const frames = assembler.push(frame.subarray(11))
    expect(frames).toHaveLength(1)
    expect(frames[0].header.seq).toBe(9)
    expect(hex(frames[0].payload)).toBe(hex(cborEncode({ off: 4096 })))
  })

  it("returns two frames arriving in one chunk", () => {
    const assembler = new SmpFrameAssembler()
    const both = new Uint8Array(frame.length * 2)
    both.set(frame, 0)
    both.set(frame, frame.length)
    expect(assembler.push(both)).toHaveLength(2)
  })

  it("drops buffered bytes on reset", () => {
    const assembler = new SmpFrameAssembler()
    assembler.push(frame.subarray(0, 5))
    assembler.reset()
    expect(assembler.push(frame)).toHaveLength(1)
  })
})
