/**
 * The live FTMS GATT session: the one stateful piece of the trainer stack.
 *
 * Everything byte-level is imported from ./protocol and ./indoor-bike-data, so
 * this file holds only the two things that cannot be expressed as a pure
 * function: the ORDER of the GATT set-up, and the queue that keeps exactly one
 * Control Point procedure outstanding.
 *
 * WHY THE ORDER MATTERS (the same hazard as lib/cps/calibration.ts, which runs
 * one-shot version of this):
 *
 *   1. The trainer rejects a Control Point write outright with ATT 0xFD (CCC
 *      Improperly Configured) unless indications are already enabled.
 *   2. An answer can arrive BEFORE writeValueWithResponse() resolves - the
 *      Kickr answers Request Control in well under a millisecond - so a
 *      listener attached after the write misses it and the op hangs until the
 *      timeout.
 *
 * So the Control Point listener is attached and indications enabled first,
 * before the two notification streams and long before any write.
 *
 * WHY THE QUEUE: FTMS allows one procedure at a time. A second concurrent write
 * is answered with ATT 0xFE (Procedure Already In Progress), which the panel
 * would surface as a mysterious failure the moment an operator clicked two
 * buttons quickly, or nudged a target slider. Serialising here means the panel
 * can fire ops freely and each one still sees its own answer.
 *
 * Structurally typed rather than taking BluetoothDevice, so the whole flow is
 * unit-testable without a Web Bluetooth environment (as in lib/cps/calibration.ts).
 */

import { parseIndoorBikeData, type IndoorBikeData } from "./indoor-bike-data"
import {
  DEFAULT_POWER_RANGE,
  DEFAULT_RESISTANCE_RANGE,
  FTMS_CONTROL_POINT_CHAR_UUID,
  FTMS_FEATURE_CHAR_UUID,
  FTMS_INDOOR_BIKE_DATA_CHAR_UUID,
  FTMS_MACHINE_STATUS_CHAR_UUID,
  FTMS_OP,
  FTMS_RESULT,
  FTMS_SERVICE_UUID,
  FTMS_STOP_PARAM,
  FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID,
  FTMS_SUPPORTED_RESISTANCE_RANGE_CHAR_UUID,
  clampToRange,
  describeOpcode,
  describeResultCode,
  parseControlPointResponse,
  parseFitnessMachineFeature,
  parseMachineStatus,
  parseSupportedPowerRange,
  parseSupportedResistanceRange,
  requestControlCommand,
  resetCommand,
  setTargetPowerCommand,
  setTargetResistanceCommand,
  startResumeCommand,
  stopPauseCommand,
  type FtmsFeatures,
  type FtmsStatus,
  type SupportedRange,
} from "./protocol"

/**
 * How long to wait for a Control Point indication.
 *
 * Trainer answers are sub-second - the procedures this panel sends are all
 * "note this target", not "run a measurement" - so 5 s is generous by an order
 * of magnitude while still being well under the point where a bench operator
 * decides the page has hung. Deliberately shorter than CALIBRATION_TIMEOUT_MS,
 * where the board's own 5 s guard has to win the race.
 */
export const FTMS_CONTROL_TIMEOUT_MS = 5000

/** The characteristic operations this session uses. A real one satisfies all of them. */
export interface FtmsCharacteristic {
  readValue: () => Promise<DataView>
  startNotifications: () => Promise<unknown>
  stopNotifications: () => Promise<unknown>
  addEventListener: (type: string, listener: (event: Event) => void) => void
  removeEventListener: (type: string, listener: (event: Event) => void) => void
  writeValueWithResponse: (value: BufferSource) => Promise<unknown>
}

export interface FtmsService {
  getCharacteristic: (uuid: string) => Promise<FtmsCharacteristic>
}

export interface FtmsServer {
  connected: boolean
  connect: () => Promise<FtmsServer>
  getPrimaryService: (uuid: string) => Promise<FtmsService>
}

export interface FtmsDevice {
  gatt?: FtmsServer | null
}

/**
 * What the trainer says it can do, read once at open time.
 *
 * `features` is null when the trainer would not tell us - unknown, not
 * unsupported, which is why the panel must not use it to grey out controls.
 * The ranges always have a value: an absent characteristic falls back to the
 * spec-wide defaults so target clamping never has to handle "no range".
 */
export interface FtmsCapabilities {
  features: FtmsFeatures | null
  powerRange: SupportedRange
  resistanceRange: SupportedRange
}

export interface FtmsSessionHandlers {
  onBikeData: (data: IndoorBikeData, receivedAtMs: number) => void
  onStatus?: (status: FtmsStatus) => void
  /** Convenience: fired for status controlPermissionLost (in addition to onStatus). */
  onControlLost?: () => void
}

/**
 * A procedure the trainer answered with something other than success.
 *
 * The raw codes ride along because the panel reacts differently to
 * CONTROL_NOT_PERMITTED (re-send Request Control) than to the rest, and
 * re-parsing the message text to find that out would be absurd.
 */
export class FtmsControlError extends Error {
  constructor(
    readonly opcode: number,
    readonly resultCode: number,
  ) {
    super(`Trainer refused ${describeOpcode(opcode)}: ${describeResultCode(resultCode)}`)
    this.name = "FtmsControlError"
  }
}

interface PendingOp {
  opcode: number
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Read one optional characteristic, or null if the trainer will not give it up.
 *
 * Any failure is the same failure as far as the bench is concerned - the
 * characteristic is missing, the read failed, or the payload did not parse - and
 * none of them is worth refusing to open the session over. The warning is what
 * makes the difference visible in the console when a trainer behaves oddly.
 */
async function readOptional<T>(
  service: FtmsService,
  uuid: string,
  parse: (value: DataView) => T,
  label: string,
): Promise<T | null> {
  try {
    const characteristic = await service.getCharacteristic(uuid)
    return parse(await characteristic.readValue())
  } catch (error) {
    console.warn(`FTMS: could not read ${label}; continuing without it`, error)
    return null
  }
}

export class FtmsSession {
  /**
   * Tail of the op queue. Every op appends with `.then(run, run)` - the SAME
   * handler on both arms - so a rejected op hands the queue straight to the next
   * one instead of poisoning it. A refused Request Control must not make the
   * Reset that fixes it unsendable.
   */
  private chain: Promise<unknown> = Promise.resolve()

  /** The one outstanding procedure, or null when the Control Point is idle. */
  private pending: PendingOp | null = null

  private disposed = false
  private attached = false

  /*
   * Arrow-function fields, not methods: add/removeEventListener must see the
   * same reference, and dispose() removing a different closure would leak a
   * listener that keeps firing into a dead session.
   */
  private readonly onControlPointIndication = (event: Event): void => {
    // Web Bluetooth delivers the payload on the characteristic itself.
    const value = (event.target as { value?: DataView | null } | null)?.value
    if (!value) return
    const parsed = parseControlPointResponse(value)
    if (!parsed) return

    const pending = this.pending
    if (!pending) return
    /*
     * Match on the request opcode. Without this, an answer the trainer sends
     * late (to an op that already timed out) would settle whatever op happens to
     * be in flight now - reporting a stale refusal against an innocent write.
     */
    if (parsed.requestOpcode !== pending.opcode) return

    clearTimeout(pending.timer)
    this.pending = null
    if (parsed.resultCode === FTMS_RESULT.SUCCESS) pending.resolve()
    else pending.reject(new FtmsControlError(pending.opcode, parsed.resultCode))
  }

  private readonly onMachineStatus = (event: Event): void => {
    const value = (event.target as { value?: DataView | null } | null)?.value
    if (!value) return
    const status = parseMachineStatus(value)
    if (!status) return
    this.handlers.onStatus?.(status)
    /*
     * Control permission is lost silently - the trainer just stops honouring
     * targets - so this is the only warning the panel gets that it has to run
     * Request Control again. Surfaced separately because every consumer cares
     * about it, whether or not it logs the rest of the status stream.
     */
    if (status.kind === "controlPermissionLost") this.handlers.onControlLost?.()
  }

  private readonly onBikeData = (event: Event): void => {
    const value = (event.target as { value?: DataView | null } | null)?.value
    if (!value) return
    const data = parseIndoorBikeData(value)
    // A short frame is one to drop, not a reason to tear down a stream that
    // arrives several times a second for the whole session.
    if (!data) return
    this.handlers.onBikeData(data, this.now())
  }

  constructor(
    readonly capabilities: FtmsCapabilities,
    private readonly controlPoint: FtmsCharacteristic,
    private readonly machineStatus: FtmsCharacteristic,
    private readonly indoorBikeData: FtmsCharacteristic,
    private readonly handlers: FtmsSessionHandlers,
    private readonly timeoutMs: number,
    private readonly now: () => number,
  ) {}

  /**
   * Attach every listener and enable every stream, Control Point FIRST.
   *
   * @internal openFtmsSession calls this before the session is handed out, which
   * is what guarantees no write can ever reach an unsubscribed Control Point.
   * Guarded rather than trusted: a second call would attach a second copy of
   * every listener, and each indication would then settle nothing twice over.
   */
  async attach(): Promise<void> {
    if (this.attached) return
    this.attached = true

    this.controlPoint.addEventListener("characteristicvaluechanged", this.onControlPointIndication)
    await this.controlPoint.startNotifications()

    this.machineStatus.addEventListener("characteristicvaluechanged", this.onMachineStatus)
    await this.machineStatus.startNotifications()

    this.indoorBikeData.addEventListener("characteristicvaluechanged", this.onBikeData)
    await this.indoorBikeData.startNotifications()
  }

  /** Take control; every target-setting op is refused with 0x05 until this succeeds. */
  requestControl(): Promise<void> {
    return this.send(FTMS_OP.REQUEST_CONTROL, requestControlCommand)
  }

  /** Reset: the trainer drops its targets and releases control back. */
  reset(): Promise<void> {
    return this.send(FTMS_OP.RESET, resetCommand)
  }

  /** ERG mode. Clamped and snapped onto the trainer's own published grid first. */
  setTargetPower(watts: number): Promise<void> {
    return this.send(FTMS_OP.SET_TARGET_POWER, () =>
      setTargetPowerCommand(clampToRange(watts, this.capabilities.powerRange)),
    )
  }

  /**
   * Resistance mode, in tenths of a level.
   *
   * Clamped onto the published range, which is int16 - but the wire carries one
   * uint8, so a trainer publishing a max above 255 tenths leaves values this
   * command cannot express. setTargetResistanceCommand throws for those, and the
   * throw happens inside the queued run, so the op rejects without writing
   * anything and the queue moves on.
   */
  setTargetResistance(tenths: number): Promise<void> {
    return this.send(FTMS_OP.SET_TARGET_RESISTANCE, () =>
      setTargetResistanceCommand(clampToRange(tenths, this.capabilities.resistanceRange)),
    )
  }

  /** Start or Resume. The Kickr applies ERG targets only once this has been sent. */
  start(): Promise<void> {
    return this.send(FTMS_OP.START_RESUME, startResumeCommand)
  }

  stop(): Promise<void> {
    return this.send(FTMS_OP.STOP_PAUSE, () => stopPauseCommand(FTMS_STOP_PARAM.STOP))
  }

  pause(): Promise<void> {
    return this.send(FTMS_OP.STOP_PAUSE, () => stopPauseCommand(FTMS_STOP_PARAM.PAUSE))
  }

  /**
   * Detach from the characteristics and fail anything in flight. Idempotent.
   *
   * A leaked listener is not cosmetic: the characteristics outlive this session
   * object (the panel can re-open one on the same device), and a stale listener
   * would settle the new session's ops from the old session's answers.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    const pending = this.pending
    if (pending) {
      clearTimeout(pending.timer)
      this.pending = null
      pending.reject(new Error("session disposed"))
    }

    this.controlPoint.removeEventListener("characteristicvaluechanged", this.onControlPointIndication)
    this.machineStatus.removeEventListener("characteristicvaluechanged", this.onMachineStatus)
    this.indoorBikeData.removeEventListener("characteristicvaluechanged", this.onBikeData)

    // Best-effort, and one characteristic's failure must not skip the next:
    // dispose usually runs BECAUSE the link went away, and failing to unsubscribe
    // from a characteristic that no longer exists is not news.
    for (const characteristic of [this.controlPoint, this.machineStatus, this.indoorBikeData]) {
      await characteristic.stopNotifications().catch(() => {})
    }
  }

  /**
   * Queue one procedure and resolve when the trainer answers it.
   *
   * The command is encoded inside the queued run, not here, so a value the wire
   * cannot carry rejects in this op's turn rather than throwing synchronously out
   * of a method the panel called for its promise.
   */
  private send(opcode: number, encode: () => Uint8Array<ArrayBuffer>): Promise<void> {
    const run = () => this.writeAndAwait(opcode, encode)
    const next = this.chain.then(run, run)
    /*
     * The queue tail holds this op's promise and the caller gets the same one,
     * so its rejection is always handled - by the caller, and by the next op's
     * `.then(run, run)`. Nothing here needs a swallowing `.catch`.
     */
    this.chain = next
    return next
  }

  private writeAndAwait(opcode: number, encode: () => Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("session disposed"))

    let command: Uint8Array<ArrayBuffer>
    try {
      command = encode()
    } catch (error) {
      return Promise.reject(asError(error))
    }

    /*
     * The Promise executor runs synchronously, so `pending` is in place before
     * writeValueWithResponse() is even called - the whole point, since the
     * answer can beat the write's own resolution.
     */
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Clear pending so a late answer cannot settle the NEXT op, and so the
        // session stays usable rather than wedged behind a dead procedure. The
        // identity check keeps this honest even if the timer ever outlived its op.
        if (this.pending?.timer === timer) this.pending = null
        reject(
          new Error(
            `Trainer did not answer ${describeOpcode(opcode)} within ${Math.round(this.timeoutMs / 1000)} s`,
          ),
        )
      }, this.timeoutMs)

      const settled = { opcode, resolve, reject, timer } satisfies PendingOp
      this.pending = settled

      this.controlPoint.writeValueWithResponse(command).catch((error: unknown) => {
        // ATT errors arrive here: 0xFD when indications are not enabled, 0xFE
        // when a procedure is already in progress. Only tear down the pending op
        // if it is still ours - a fast answer may already have settled it.
        if (this.pending !== settled) return
        clearTimeout(timer)
        this.pending = null
        reject(asError(error))
      })
    })
  }
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

/**
 * Connect, learn what the trainer can do, subscribe to everything, and hand
 * back a session ready to drive.
 *
 * The capability reads happen before the subscriptions purely for reporting
 * order in the console; the guarantee that matters is that the Control Point is
 * subscribed before the caller can possibly write, which holds because the
 * session does not exist until this resolves.
 *
 * @param options.timeoutMs per-op wait; see FTMS_CONTROL_TIMEOUT_MS first.
 * @param options.now clock for the onBikeData timestamps, injectable for tests.
 */
export async function openFtmsSession(
  device: FtmsDevice | null | undefined,
  handlers: FtmsSessionHandlers,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<FtmsSession> {
  const gatt = device?.gatt
  if (!gatt) throw new Error("Device has no GATT interface")
  const server = gatt.connected ? gatt : await gatt.connect()
  const service = await server.getPrimaryService(FTMS_SERVICE_UUID)

  const features = await readOptional(
    service,
    FTMS_FEATURE_CHAR_UUID,
    parseFitnessMachineFeature,
    "the Fitness Machine Feature characteristic",
  )
  const powerRange =
    (await readOptional(
      service,
      FTMS_SUPPORTED_POWER_RANGE_CHAR_UUID,
      parseSupportedPowerRange,
      "the Supported Power Range characteristic",
    )) ?? DEFAULT_POWER_RANGE
  const resistanceRange =
    (await readOptional(
      service,
      FTMS_SUPPORTED_RESISTANCE_RANGE_CHAR_UUID,
      parseSupportedResistanceRange,
      "the Supported Resistance Level Range characteristic",
    )) ?? DEFAULT_RESISTANCE_RANGE

  const controlPoint = await service.getCharacteristic(FTMS_CONTROL_POINT_CHAR_UUID)
  const machineStatus = await service.getCharacteristic(FTMS_MACHINE_STATUS_CHAR_UUID)
  const indoorBikeData = await service.getCharacteristic(FTMS_INDOOR_BIKE_DATA_CHAR_UUID)

  const session = new FtmsSession(
    { features, powerRange, resistanceRange },
    controlPoint,
    machineStatus,
    indoorBikeData,
    handlers,
    options.timeoutMs ?? FTMS_CONTROL_TIMEOUT_MS,
    options.now ?? Date.now,
  )
  /*
   * A half-attached session is the one case where the caller gets an error and
   * still owns nothing it could clean up: the Control Point listener would stay
   * on the characteristic, firing into a session object nobody holds a reference
   * to. So the failure is undone here before it is re-thrown.
   */
  try {
    await session.attach()
  } catch (error) {
    await session.dispose()
    throw error
  }
  return session
}
