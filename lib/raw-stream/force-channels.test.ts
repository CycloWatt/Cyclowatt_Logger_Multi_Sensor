import { describe, expect, it } from "vitest"
import {
  FORCE_CHANNELS,
  FORCE_SENSOR_COUNT,
  FORCE_SLOTS_FIRST,
  FORCE_SLOTS_SECOND,
  forceChannelLabel,
  forceDataKey,
} from "./force-channels"
import { FORCE_CHANNEL_COUNT } from "./force-offsets"

describe("FORCE_CHANNELS", () => {
  it("covers every board channel exactly once, in slot order", () => {
    expect(FORCE_CHANNELS).toHaveLength(FORCE_CHANNEL_COUNT)
    expect(FORCE_CHANNELS.map((c) => c.slot)).toEqual([0, 1, 2, 3, 4, 5])
  })

  /*
   * The load-bearing assertion in this file. Slot n and slot n+3 are the two
   * amplifier outputs of ONE load cell (schematic sheet 3: "Force Sensor N" with
   * a compression and a shear output), so they must agree on position, sensor and
   * connector. The bug this replaces grouped channels by n % 2 instead, which
   * pairs slots belonging to DIFFERENT cells - and would pass any test that only
   * checked the table's shape.
   */
  it("pairs slot n with slot n+3 as the same physical sensor", () => {
    for (const first of FORCE_SLOTS_FIRST) {
      const second = first + FORCE_SENSOR_COUNT

      expect(FORCE_CHANNELS[second].position).toBe(FORCE_CHANNELS[first].position)
      expect(FORCE_CHANNELS[second].sensor).toBe(FORCE_CHANNELS[first].sensor)
      expect(FORCE_CHANNELS[second].connector).toBe(FORCE_CHANNELS[first].connector)
    }
  })

  it("splits the slots into one channel per position each", () => {
    expect([...FORCE_SLOTS_FIRST, ...FORCE_SLOTS_SECOND]).toEqual([0, 1, 2, 3, 4, 5])
    expect(FORCE_SLOTS_FIRST).toHaveLength(FORCE_SENSOR_COUNT)
    expect(FORCE_SLOTS_SECOND).toHaveLength(FORCE_SENSOR_COUNT)
  })

  it("uses each position, sensor and connector for exactly two slots", () => {
    for (const key of ["position", "sensor", "connector"] as const) {
      const counts = new Map<unknown, number>()
      for (const channel of FORCE_CHANNELS) {
        counts.set(channel[key], (counts.get(channel[key]) ?? 0) + 1)
      }

      expect(counts.size).toBe(FORCE_SENSOR_COUNT)
      expect([...counts.values()]).toEqual([2, 2, 2])
    }
  })

  /*
   * Pins the bench wiring itself, not just its shape. It is not derivable from
   * any file in either firmware repo - the devicetree and the schematic carry no
   * front/left/right/back label at all - so the only evidence for it is a press
   * test: on 2026-08-26, pressing front-right moved Ch 0, back moved Ch 1 and
   * front-left moved Ch 2. A change here is therefore a real rewire, and this
   * test is the prompt to re-run that press test before it lands.
   */
  it("records the press-verified bench positions", () => {
    expect(FORCE_CHANNELS.map((c) => c.position)).toEqual([
      "front-right",
      "back",
      "front-left",
      "front-right",
      "back",
      "front-left",
    ])
  })
})

describe("forceDataKey", () => {
  it("names the chart series for every slot", () => {
    expect(FORCE_CHANNELS.map((c) => forceDataKey(c.slot))).toEqual([
      "force0",
      "force1",
      "force2",
      "force3",
      "force4",
      "force5",
    ])
  })
})

describe("forceChannelLabel", () => {
  it("names index, position and connector", () => {
    expect(forceChannelLabel(0)).toBe("Ch 0 - front-right (J2)")
    expect(forceChannelLabel(4)).toBe("Ch 4 - back (J4)")
  })

  it("labels every slot", () => {
    for (const channel of FORCE_CHANNELS) {
      expect(forceChannelLabel(channel.slot)).toBe(
        `Ch ${channel.slot} - ${channel.position} (${channel.connector})`,
      )
    }
  })

  // A slot outside the table is a caller bug, but a thrown error inside a chart
  // legend would blank the whole card. Degrade to the bare index instead.
  it("falls back to the bare index for an unknown slot", () => {
    expect(forceChannelLabel(FORCE_CHANNEL_COUNT)).toBe("Ch 6")
  })
})
