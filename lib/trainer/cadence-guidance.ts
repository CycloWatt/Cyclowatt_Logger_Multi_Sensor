/** A small tolerance prevents alternating cues for normal cadence variation. */
export function cadenceCue(target: number | undefined, measured: number | null): string {
  if (target === undefined) return "Set a cadence target in the protocol steps."
  if (measured === null || !Number.isFinite(measured)) return "Waiting for fresh cadence data"
  if (measured < target - 5) return "Pedal faster"
  if (measured > target + 5) return "Pedal slower"
  return "On target"
}
