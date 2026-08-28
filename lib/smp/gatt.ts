/**
 * Opens (or reuses) the GATT link and returns an initialized SMP client. Caller
 * disposes. Lives outside the DFU card because the bench panel needs the same
 * attach sequence for its own short-lived, per-action clients.
 */

import { SMP_CHARACTERISTIC_UUID, SMP_SERVICE_UUID, SmpClient } from "./client"

/** Connect (or re-connect) the GATT link and attach an SMP client to it. */
export async function openSmpClient(target: BluetoothDevice): Promise<SmpClient> {
  if (!target.gatt) throw new Error("Device has no GATT interface")
  const server = target.gatt.connected ? target.gatt : await target.gatt.connect()
  const service = await server.getPrimaryService(SMP_SERVICE_UUID)
  const characteristic = await service.getCharacteristic(SMP_CHARACTERISTIC_UUID)
  const client = new SmpClient(characteristic)
  await client.initialize()
  return client
}
