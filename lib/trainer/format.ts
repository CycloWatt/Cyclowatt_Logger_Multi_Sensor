/**
 * The one mm:ss formatter the Trainer tab uses.
 *
 * It lived in three places - the panel, the chart's X axis and the step
 * editor's total - which is three chances for the same number to be rendered
 * differently on one screen. There is no such thing as a chart axis that
 * rounds while the readout beside it floors, so it is one function now.
 *
 * Pure and free of any DOM, so it sits in lib/ and is unit-testable in plain
 * node like everything else here.
 */

/**
 * Seconds as `MM:SS`, minutes NOT rolled into hours: a 90-minute protocol reads
 * "90:00", because a bench operator compares it against a step list written in
 * minutes and an "01:30:00" would have to be converted back in their head.
 *
 * FLOORS, like a stopwatch: the 65th second reads "01:05" for the whole of it.
 * Rounding would tick a countdown over to the next value while half a second
 * was still left on it, and make an elapsed clock claim time that has not
 * passed yet.
 *
 * Negative and non-finite inputs both render "00:00" rather than "-1:-1" or
 * "NaN:NaN": a remaining-time readout dips slightly below zero between a step
 * boundary and the tick that notices it, and a display is the wrong place to
 * discover it.
 */
export function mmss(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.floor(Math.max(0, seconds)) : 0
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}
