/**
 * Running a zero-offset calibration over the Cycling Power Control Point.
 *
 * The same procedure a head unit runs, driven from the bench page. Split from
 * ./protocol so the byte-level rules stay pure and this file can hold the one
 * genuinely tricky part: the ORDER of the GATT operations.
 *
 * Structurally typed rather than taking BluetoothDevice, so the whole flow is
 * unit-testable without a Web Bluetooth environment (the same approach as
 * lib/gap-name.ts and lib/smp/gatt.ts).
 *
 * WHY THIS IS ASYNCHRONOUS AT ALL: the firmware collects 200 samples at 80 Hz
 * before it can answer, so the response is an INDICATION arriving ~2.5 s after
 * the write, not a value returned by it. The write resolving means "the board
 * accepted the request", never "the board is calibrated".
 */

import {
  CPS_CONTROL_POINT_CHAR_UUID,
  CPS_FEATURE_CHAR_UUID,
  CPS_OPCODE_START_OFFSET_COMPENSATION,
  CPS_RESPONSE_SUCCESS,
  CPS_SERVICE_UUID,
  describeResponseCode,
  offsetCompensationSupported,
  parseControlPointResponse,
  readFeatureBits,
  startOffsetCompensationCommand,
  type ControlPointResponse,
} from "./protocol"

/**
 * How long to wait for the board's answer.
 *
 * Deliberately LONGER than the firmware's own 5 s guard (FORCE_CAL_TIMEOUT), so a
 * starved sample pipeline loses the race to the board's own OPERATION_FAILED
 * response. The operator then sees a real response code instead of a client-side
 * give-up, which is the difference between "the board could not finish" and the
 * far less useful "the website stopped waiting". Still well inside the 30 s the
 * CPS spec allows a procedure.
 */
export const CALIBRATION_TIMEOUT_MS = 10000

/** The characteristic operations this flow uses. A real one satisfies all of them. */
export interface CpsCharacteristic {
  readValue: () => Promise<DataView>
  startNotifications: () => Promise<unknown>
  stopNotifications: () => Promise<unknown>
  addEventListener: (type: string, listener: (event: Event) => void) => void
  removeEventListener: (type: string, listener: (event: Event) => void) => void
  writeValueWithResponse: (value: BufferSource) => Promise<unknown>
}

export interface CpsService {
  getCharacteristic: (uuid: string) => Promise<CpsCharacteristic>
}

export interface CpsServer {
  getPrimaryService: (uuid: string) => Promise<CpsService>
}

export interface CalibratableDevice {
  gatt?: (CpsServer & { connected: boolean; connect: () => Promise<CpsServer> }) | null
}

/**
 * Run one calibration and resolve the resulting average per-sensor offset in
 * Newtons.
 *
 * Rejects with a bench-readable Error for every failure: an unsupported board, a
 * refused procedure (the response code is named), a board that never answers, or
 * a GATT-level failure. The two ATT errors worth recognising arrive as a rejected
 * write - 0xFD when control-point indications are not enabled, and 0xFE when
 * another Control Point procedure is already running.
 *
 * @param device the connected board.
 * @param options.timeoutMs override the wait; see CALIBRATION_TIMEOUT_MS first.
 */
export async function runOffsetCompensation(
  device: CalibratableDevice | null | undefined,
  options: { timeoutMs?: number } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? CALIBRATION_TIMEOUT_MS

  const gatt = device?.gatt
  if (!gatt) throw new Error("Device has no GATT interface")
  const server = gatt.connected ? gatt : await gatt.connect()
  const service = await server.getPrimaryService(CPS_SERVICE_UUID)

  /*
   * Ask the board whether it can do this BEFORE asking it to. The Feature
   * characteristic is the board's own declaration, so an image from before
   * calibration landed says so in one readable sentence instead of failing an
   * opaque write several seconds later.
   */
  const feature = await service.getCharacteristic(CPS_FEATURE_CHAR_UUID)
  if (!offsetCompensationSupported(readFeatureBits(await feature.readValue()))) {
    throw new Error(
      "This board's firmware does not support offset compensation " +
        "(Cycling Power feature bit 9 is clear). Flash a build with calibration first.",
    )
  }

  const controlPoint = await service.getCharacteristic(CPS_CONTROL_POINT_CHAR_UUID)

  /* Initialised to a no-op so the finally below is safe on every early exit. */
  let detach = () => {}
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    /*
     * THE ORDERING THAT MATTERS. The listener is attached and indications enabled
     * BEFORE the write, for two independent reasons:
     *
     *   1. The firmware rejects a control-point write outright with ATT 0xFD (CCC
     *      Improperly Configured) unless indications are already on.
     *   2. A procedure that fails fast can be answered before
     *      writeValueWithResponse() resolves. A listener attached after the write
     *      would miss that answer entirely and hang until the timeout.
     *
     * The Promise executor runs synchronously, so constructing this promise is
     * what performs the attach - it is not merely preparing to.
     */
    const answered = new Promise<ControlPointResponse>((resolve, reject) => {
      const onIndication = (event: Event) => {
        // Web Bluetooth delivers the payload on the characteristic itself.
        const value = (event.target as { value?: DataView | null } | null)?.value
        if (!value) return
        const parsed = parseControlPointResponse(value)
        if (!parsed) return
        /*
         * Filter on the request opcode. Crank-length reads and writes answer on
         * this same characteristic, and resolving on one of those would report a
         * crank length to the operator as a force offset.
         */
        if (parsed.requestOpcode !== CPS_OPCODE_START_OFFSET_COMPENSATION) return
        resolve(parsed)
      }

      controlPoint.addEventListener("characteristicvaluechanged", onIndication)
      detach = () => controlPoint.removeEventListener("characteristicvaluechanged", onIndication)

      timer = setTimeout(() => {
        reject(
          new Error(
            `The board did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
              "It may have lost the link, or its sample pipeline is starved.",
          ),
        )
      }, timeoutMs)
    })

    await controlPoint.startNotifications()
    await controlPoint.writeValueWithResponse(startOffsetCompensationCommand())

    const response = await answered

    if (response.responseCode !== CPS_RESPONSE_SUCCESS) {
      throw new Error(`The board refused the calibration: ${describeResponseCode(response.responseCode)}`)
    }
    if (response.parameter === null) {
      // Reporting "calibrated" with no number would be worse than an error: the
      // operator would have nothing to sanity-check the tare against.
      throw new Error("The board reported success without an offset value")
    }

    return response.parameter
  } finally {
    /*
     * Both cleanups run on every path, including a rejection. A leaked listener is
     * not cosmetic: the next calibration would share this characteristic and could
     * resolve from this run's late answer.
     */
    if (timer !== null) clearTimeout(timer)
    detach()
    // Best-effort: the link may already be gone, and failing to stop indications
    // must not replace the real error with a less useful one.
    await controlPoint.stopNotifications().catch(() => {})
  }
}
