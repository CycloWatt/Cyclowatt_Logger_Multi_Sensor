/**
 * The firmware advertises "Cyclowatt [L|R] v<major.minor.patch>" (DAQ images
 * may truncate the suffix away, firmware T23) — extract the version so bench
 * captures are attributable to a firmware build.
 */
export function firmwareVersionFromName(name: string | null | undefined): string | null {
  const match = /\sv(\d+\.\d+\.\d+)$/.exec(name ?? "")
  return match ? match[1] : null
}
