/**
 * Keeping the scan list's display names in step with the boards' LIVE names.
 *
 * On this bench a board's name changes all the time: every firmware flash bumps
 * the " v<major.minor.patch>" suffix the firmware appends to its GAP name. The
 * page's device list stores a name snapshot taken when the entry was created (a
 * chooser pick, or a remembered permission grant from getDevices()), so that
 * snapshot goes stale the moment the board is reflashed - and it is exactly the
 * field a bench operator reads to tell boards and builds apart.
 *
 * WHAT DOES NOT WORK, because it is the trap this module exists to avoid:
 * re-reading `BluetoothDevice.name`. Chrome caches that property when the device
 * is granted/paired and NEVER refreshes it - not when a connection re-reads the
 * GAP name, and not while watchAdvertisements() is delivering advertisements
 * that carry a different name (upstream: WebBluetoothCG/web-bluetooth#570). A
 * sync built on it cannot learn a new name, and worse, it OVERWRITES a correct
 * name with the frozen one - which is how a freshly corrected row reverted to
 * the build the board used to run.
 *
 * So `device.name` may only ever SEED a brand-new row. Updating an existing row
 * takes one of the two genuinely live sources, both of which arrive through
 * applyDeviceName():
 *
 *   - "advertisement": BluetoothAdvertisingEvent.name, read per event straight
 *     off the air. Fresh, needs no connection, but a data-acquisition image
 *     truncates its on-air name to 11 characters, so it can be SHORTER than the
 *     truth.
 *   - "gap": the Device Name characteristic (0x2A00) read from the Generic
 *     Access service (0x1800) after connecting. Authoritative and full length -
 *     it is the string the firmware actually set.
 */

/**
 * Where a candidate name came from, which is what decides whether it may
 * shorten the name already on the row. See NAME_ORIGIN handling in
 * nextDisplayName().
 */
export type NameOrigin = "advertisement" | "gap"

/** The minimal row shape name refreshing needs: an id to match on, and the name to keep current. */
export interface NamedDeviceEntry {
  id: string
  name: string
}

/**
 * Which name a row should show, given a candidate. Pure, and returns the CURRENT
 * string unchanged whenever the candidate adds nothing - callers rely on that to
 * preserve object identity.
 *
 * Three guards, in order:
 *   1. An empty/absent candidate never wins. Web Bluetooth leaves a name
 *      undefined for a device that advertises none, and a blank row identifies
 *      nothing at all, where a stale row at least identifies the board.
 *   2. An identical candidate is not a change.
 *   3. A candidate that is a PREFIX of what the row already shows is a
 *      truncation, not news - "CRaw L B2C3" arriving over an existing
 *      "CRaw L B2C3 v0.6.2" is that same board's clipped 11-character on-air
 *      name, and adopting it would throw away the version. An authoritative
 *      "gap" read is exempt: it is the full string from the board, so if it
 *      really is shorter now, the name really did get shorter.
 *
 * Anything else is a genuine rename and is adopted - including an advertised
 * name that differs from a previous "gap" read, since a reflash between the two
 * makes the newer observation the true one.
 */
export function nextDisplayName(
  current: string,
  candidate: string | null | undefined,
  origin: NameOrigin,
): string {
  if (!candidate) return current
  if (candidate === current) return current
  if (origin !== "gap" && current.startsWith(candidate)) return current
  return candidate
}

/**
 * Apply a freshly observed name to the matching row, plus any sibling fields
 * that the same observation proves (the advertisement path also latches
 * `inRange`).
 *
 * Identity-preserving at both levels: when nothing changed the SAME array comes
 * back, so a React state setter fed this result bails out of the re-render
 * instead of looping, and untouched rows keep their own object identity so
 * memoized children below them do not re-render either. This matters more than
 * it looks - advertisements repeat several times a second.
 */
export function applyDeviceName<T extends NamedDeviceEntry>(
  entries: T[],
  id: string,
  candidate: string | null | undefined,
  origin: NameOrigin,
  patch?: Partial<T>,
): T[] {
  let changed = false
  const next = entries.map((entry) => {
    if (entry.id !== id) return entry
    const name = nextDisplayName(entry.name, candidate, origin)
    // A patch field already holding its target value is not a change either,
    // which is what stops a repeating advertisement from re-rendering the row
    // once `inRange` is already latched.
    const patchDiffers = patch
      ? Object.keys(patch).some((key) => entry[key as keyof T] !== patch[key as keyof T])
      : false
    if (name === entry.name && !patchDiffers) return entry
    changed = true
    return { ...entry, ...patch, name } as T
  })
  return changed ? next : entries
}
