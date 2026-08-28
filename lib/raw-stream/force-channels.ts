/**
 * What each of the six force channels physically is: which load-cell POSITION it
 * belongs to, and which amplifier slot on the board it comes out of.
 *
 * This module exists because the screen used to answer that question with
 * arithmetic - even channel = compression, odd channel = shear - and that rule is
 * wrong. It is wrong in a way that looks half-right, which is what made it
 * survive: channels 0 and 2 really are one axis and 3 and 5 really are the other,
 * so four of the six labels agreed with the hardware by coincidence and only
 * channels 1 and 4 gave it away.
 *
 * THE CHANNEL INDEX IS THE BOARD'S OWN. Nothing between the ADC and this screen
 * permutes it, so `force0..force5` here are `Vout_meas_1..6` on the PCB:
 *   - power-meter-fw `src/drivers/force_sensor.c` fills `mv_out[i]` from
 *     `adc_channels[ADC_CH_FORCE_FIRST + i]` - a straight walk, no remap.
 *   - `boards/cyclowatt/cyclowatt.dts` (`zephyr,user`) pins io-channels 1..6 to
 *     `Vout_meas_1..6` (AIN7/1/5/4/3/6).
 *   - `src/services/raw_stream_wire.c` packs slot i to wire slot i verbatim.
 * The logger chain is the odd one out and deliberately so: `parse_cyclowatt` in
 * logger-fw applies `FORCE_PERM = [0,3,1,4,2,5]` to regroup the wire order into
 * its per-sensor CSV columns. So this app's `force_N` is logger WIRE index N, not
 * logger column N - see the cross-check in the plan's verification notes.
 *
 * SLOT -> POSITION comes from the schematic (`cyclowatt_pcb_v3.pdf` sheet 3),
 * which labels three amplifier columns `Force Sensor 1/2/3` on connectors
 * J2/J4/J5, each with a compression output (`Vout_1..3`) and a shear output
 * (`Vout_4..6`). That is what makes slot n and slot n+3 the SAME physical sensor -
 * the invariant this table encodes and its test pins.
 *
 * WHICH CONNECTOR SITS WHERE ON THE SHOE IS NOT IN ANY FILE. Neither the
 * devicetree nor the schematic contains a single front/left/right/back label; it
 * is a harness fact, so the only way to establish it is to press each cell and
 * watch which channel moves. Verified that way on 2026-08-26: front-right moved
 * Ch 0, back moved Ch 1, front-left moved Ch 2. The positions below are that
 * measurement, and they contradict BOTH upstream docs that claim to record this
 * (logger-fw `doc/architecture.md` "Force channel mapping" has sensor 2 =
 * front-left and sensor 3 = back-center; power-meter-fw's generated
 * `force_channel_calibration_constants.inc` has sensor 1 = front_left). Those are
 * theirs to fix. THIS TABLE IS THE BENCH TRUTH AND MUST BE UPDATED ON REWIRE.
 *
 * DELIBERATELY NO AXIS FIELD. The `(compression)` / `(sheer)` tags in the
 * schematic describe amplifier routing only - which amp output lands on which
 * slot - not which bridge of a load cell is plugged into that amp's input. That
 * part is a soldering decision, it is tracked nowhere, and the bench does not
 * currently distinguish the two axes at all. Naming an axis here would be the
 * same class of guess the even/odd rule was.
 *
 * DELIBERATELY NO `live` FLAG either. Which channels carry a signal changes with
 * the hardware setup, so all six stay available and visible by default. A
 * hardcoded "this one is unused" is exactly the assumption that caused the
 * original bug.
 *
 * NO POLARITY FIELD, for now, but the measurement is worth writing down: under
 * load the two FRONT channels move NEGATIVE (Ch 0, Ch 2) and back moves POSITIVE
 * (Ch 1). Nothing in this app depends on sign yet, so a field with no consumer
 * would just be another unverified claim to maintain. Two consequences to know
 * before anything starts combining channels:
 *   - the `force0_2` sum on the first force graph adds Ch 0 and Ch 2, which share
 *     a sign, so it is physically meaningful as it stands. Folding Ch 1 into any
 *     such sum would partially CANCEL rather than add.
 *   - the front pair moving negative matches the polarity power-meter-fw expects
 *     of its two front cells (`power_estimation_glue_math.h`: "press front_left ->
 *     force_mv[0] must move DOWN"). What does NOT match is which slots those are:
 *     it expects the front pair on slots 0 and 1, this bench has it on 0 and 2 -
 *     independent corroboration of the position conflict noted above.
 */

import { FORCE_CHANNEL_COUNT } from "./force-offsets"

/** Load-cell mounting position, seen from above over the shoe. */
export type SensorPosition = "front-right" | "back" | "front-left"

/** The board connector a position's load cell plugs into. */
export type SensorConnector = "J2" | "J4" | "J5"

export interface ForceChannel {
  /** Board channel index, 0-5. Identical to the wire slot and to `force{slot}`. */
  slot: number
  position: SensorPosition
  /** Schematic sheet 3's "Force Sensor N" amplifier column, 1-3. */
  sensor: 1 | 2 | 3
  connector: SensorConnector
}

/**
 * Every force channel, indexed by slot.
 *
 * Read it as three sensors of two channels each: slot n and slot n+3 are the two
 * amplifier outputs of ONE load cell, hence the same position, sensor number and
 * connector.
 */
export const FORCE_CHANNELS: readonly ForceChannel[] = [
  { slot: 0, position: "front-right", sensor: 1, connector: "J2" },
  { slot: 1, position: "back", sensor: 2, connector: "J4" },
  { slot: 2, position: "front-left", sensor: 3, connector: "J5" },
  { slot: 3, position: "front-right", sensor: 1, connector: "J2" },
  { slot: 4, position: "back", sensor: 2, connector: "J4" },
  { slot: 5, position: "front-left", sensor: 3, connector: "J5" },
]

/**
 * The chart/CSV key for a slot.
 *
 * Exists so the six key strings are derived in one place rather than retyped at
 * every chart definition - a mistyped `force4` for `force5` is invisible in a
 * legend and silently plots the wrong cell.
 */
export function forceDataKey(slot: number): string {
  return `force${slot}`
}

/**
 * How a channel is named on screen: index, position, connector.
 *
 * The connector is in the label on purpose. It is the one part an operator can
 * act on directly - a trace that looks wrong is a question about a specific plug.
 */
export function forceChannelLabel(slot: number): string {
  const channel = FORCE_CHANNELS[slot]
  if (!channel) return `Ch ${slot}`

  return `Ch ${slot} - ${channel.position} (${channel.connector})`
}

/** Slots whose channel is a sensor's FIRST amp output: 0, 1, 2 - one per position. */
export const FORCE_SLOTS_FIRST: readonly number[] = [0, 1, 2]

/** Slots whose channel is a sensor's SECOND amp output: 3, 4, 5 - one per position. */
export const FORCE_SLOTS_SECOND: readonly number[] = [3, 4, 5]

/** Distance between a sensor's two slots. Also the number of positions. */
export const FORCE_SENSOR_COUNT = FORCE_CHANNEL_COUNT / 2
