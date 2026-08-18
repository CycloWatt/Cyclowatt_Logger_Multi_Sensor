/**
 * Reading a board's CURRENT name off the board itself.
 *
 * The one authoritative source of a live GAP name in Web Bluetooth: the Device
 * Name characteristic (0x2A00) of the Generic Access service (0x1800), read over
 * an open connection. `BluetoothDevice.name` cannot serve this role - Chrome
 * freezes it at grant time and never updates it (see lib/device-list.ts for the
 * full account) - so after a flash renames a board, this read is what tells the
 * page the new name.
 *
 * Two facts make this reachable rather than theoretical:
 *   - Neither 0x1800 nor 0x2A00 is on the Web Bluetooth GATT blocklist, so a
 *     read is permitted (only WRITING a device name is blocked).
 *   - "generic_access" is already listed in optionalServices on every connect
 *     path in the page, and Chrome only lets a page reach services declared at
 *     requestDevice() time. Any new connect path must keep listing it.
 */

/**
 * The slice of BluetoothDevice this read touches, structurally typed so the unit
 * tests need no Web Bluetooth environment.
 */
export interface GapNameReadable {
  gatt?: {
    connected: boolean
    getPrimaryService: (service: string) => Promise<{
      getCharacteristic: (characteristic: string) => Promise<{
        readValue: () => Promise<DataView>
      }>
    }>
  } | null
}

/**
 * The board's current GAP name, or null if it could not be read.
 *
 * Null is a normal outcome, not an error worth surfacing: the caller's fallback
 * is simply to leave the row's existing name alone. It happens when
 *   - the link is not up (nothing to read over),
 *   - the platform's Bluetooth stack hides service 0x1800 from the page,
 *   - the grant predates "generic_access" in optionalServices, which Chrome
 *     rejects with SecurityError until the device is re-picked once through the
 *     chooser (the same trap the battery service documents), or
 *   - the characteristic reads back blank.
 *
 * Hence the blanket catch: every one of those is "no name available", and none
 * of them should break a connect that otherwise succeeded.
 */
export async function readGapDeviceName(device: GapNameReadable | null | undefined): Promise<string | null> {
  const gatt = device?.gatt
  if (!gatt?.connected) return null
  try {
    const service = await gatt.getPrimaryService("generic_access")
    const characteristic = await service.getCharacteristic("gap.device_name")
    const value = await characteristic.readValue()
    // The characteristic is a plain UTF-8 string, but a firmware that sizes the
    // attribute to a fixed buffer pads the tail with NULs - decoding those
    // straight through would put invisible characters in a filename and make an
    // equality check against the advertised name fail for no visible reason.
    const decoded = new TextDecoder().decode(value).replace(/\0+$/, "").trim()
    return decoded || null
  } catch (err) {
    // Swallowed by design (every cause above is "no name available"), but NOT
    // silently: a read that fails leaves the old name on screen, which looks
    // exactly like the bug this whole path exists to fix. Naming the cause is the
    // difference between "the fix does nothing" and "this grant needs repairing".
    //
    // SecurityError here means the grant predates "generic_access" in
    // optionalServices - Chrome scopes service access to what was declared when
    // the device was picked, so an old grant stays locked out until the board is
    // re-picked through the chooser once.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.warn(
      `Could not read the device name from the board (${reason}). ` +
        "Showing the name Chrome cached at grant time, which may name an older build. " +
        "If this is a SecurityError, re-pick the board through Scan once to repair the grant.",
    )
    return null
  }
}
