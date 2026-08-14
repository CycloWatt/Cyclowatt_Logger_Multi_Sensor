/**
 * The BLE device-name contract with the firmware, in one place.
 *
 * The firmware composes every name as "<base> <tag> v<major.minor.patch>", e.g.
 * "Cyclowatt L A3F1 v0.6.0". Both ends of that string are load-bearing here: the
 * leading base is what Chrome's device chooser filters on, and the trailing
 * version is what a bench capture is stamped with. The middle tag is a per-board
 * hex code from the chip's factory-unique id - it exists so two boards side by
 * side are distinguishable in a scan list, and it may only ever sit between the
 * two ends.
 */

/**
 * Name prefixes the chooser matches on - the ONLY board-identifying data Chrome
 * can filter, since it sees advertised data only and neither image advertises the
 * SMP (firmware-update) service.
 *
 * A superset of every base still in the wild, deliberately:
 *   - "Cyclowatt" - production images, unchanged since the first release.
 *   - "CRaw"      - data-acquisition images from v0.5.0 on. Shortened from
 *                   "CycloRaw" so the base plus the per-board tag exactly fills
 *                   that image's 11-character on-air name budget, the rest of
 *                   which is spent advertising the raw-stream service UUID.
 *   - "CycloRaw"  - data-acquisition images up to v0.4.0. Still needed: 0.4.0 is
 *                   an offered image on the version shelf, so a board can be
 *                   running it right now.
 *
 * Keeping the old base alongside the new one is what makes the two repos
 * independent of each other's deploy order - a board on either side of the
 * rename reaches the chooser. Drop "CycloRaw" only once no board can still be
 * running a pre-0.5.0 data-acquisition image.
 */
export const BOARD_NAME_PREFIXES = ["Cyclowatt", "CRaw", "CycloRaw"] as const

/** The same list as UI copy and console diagnostics: `Cyclowatt..., CRaw..., ...`. */
export const BOARD_NAME_PREFIX_HINT = BOARD_NAME_PREFIXES.map((prefix) => `${prefix}...`).join(", ")

/**
 * Extract the firmware version from an advertised or GAP device name, so bench
 * captures are attributable to a build.
 *
 * End-anchored, so it is indifferent to the per-board tag in the middle. Returns
 * null for a data-acquisition board's ADVERTISED name: 11 characters hold the
 * base and the tag and nothing more, so the version is clipped off on air and is
 * only readable post-connect.
 */
export function firmwareVersionFromName(name: string | null | undefined): string | null {
  const match = /\sv(\d+\.\d+\.\d+)$/.exec(name ?? "")
  return match ? match[1] : null
}
