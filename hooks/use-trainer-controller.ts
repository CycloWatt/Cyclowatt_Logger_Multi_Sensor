"use client"

/**
 * The one seam between React and TrainerController.
 *
 * Everything the trainer DOES - the chooser and its board guard, the
 * connect/reconnect/disconnect flows, the notification handlers, the runner, the
 * manual debounce, recording, the log - lives in lib/trainer/controller.ts,
 * which knows nothing about React. This hook is the whole binding, and it is
 * deliberately the only place that knows how the two are wired:
 *
 * WHY A LAZY REF, NOT `useRef(new TrainerController(...))`. That form CONSTRUCTS
 * on every render and throws the extra instances away - each one carrying live
 * closures - so the instance is built inside a null guard instead. It is a ref
 * and not state because it never changes and must outlive every render: the
 * injected closures are built exactly once, and none of them touches
 * `navigator` until it is CALLED, so the static export can still prerender the
 * page in node.
 *
 * WHY `boardDeviceId` GOES THROUGH A REF. The controller's board guard runs at
 * click time, long after the render that changed the prop, and the deps object
 * above is built once. So the prop is mirrored into a ref by an effect and the
 * dep reads that ref - the controller always sees the latest board without ever
 * being re-constructed.
 *
 * WHY ONE PIECE OF STATE. The controller rebuilds a whole snapshot object on
 * every change, so a single `useState` fed from `subscribe` is both the cheapest
 * and the most honest mirror of it. Subscribed in an effect - never during
 * render - and the snapshot is re-read once right after subscribing, in case a
 * change landed in the window between the render and the effect.
 *
 * WHY DISPOSE HANGS OFF `[controller]`. The controller instance is stable for
 * the component's life, so the cleanup cannot fire mid-session. (Under
 * StrictMode React does mount, clean up and re-mount every effect once in dev -
 * harmless here, because that happens before anything is connected and
 * `dispose()` on an idle controller touches nothing. A dispose keyed on
 * anything that CHANGES during a session would tear a live one down; that is
 * what to avoid - and it is why this is not a `[]`-mount effect either.)
 */

import { useEffect, useRef, useState } from "react"
import { openFtmsSession } from "@/lib/ftms/control"
import { TrainerController, type TrainerSnapshot } from "@/lib/trainer/controller"

export interface UseTrainerControllerOptions {
  /**
   * bluetoothSupported && isSecureContext, from the page.
   *
   * Part of the shape because it is what the panel is handed, but NOT read
   * here: `connect()`'s "not supported" error is modelled on a call-time
   * `bluetoothAvailable()` dep (this render also runs in node during the static
   * export), and the prop itself only greys out the panel's own buttons.
   */
  bluetoothAvailable: boolean
  /** The connected CycloWatt board, so the trainer chooser can reject it. */
  boardDeviceId: string | null
}

export function useTrainerController(o: UseTrainerControllerOptions): {
  snapshot: TrainerSnapshot
  controller: TrainerController
} {
  const boardDeviceIdRef = useRef(o.boardDeviceId)
  useEffect(() => {
    boardDeviceIdRef.current = o.boardDeviceId
  }, [o.boardDeviceId])

  const controllerRef = useRef<TrainerController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new TrainerController({
      openSession: openFtmsSession,
      requestDevice: (options) => navigator.bluetooth.requestDevice(options),
      // Called, not read: `connect()` must make the same call-time check the
      // panel used to make, and the panel is prerendered in node.
      bluetoothAvailable: () => typeof navigator !== "undefined" && !!navigator.bluetooth,
      boardDeviceId: () => boardDeviceIdRef.current,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      log: console,
    })
  }
  const controller = controllerRef.current

  const [snapshot, setSnapshot] = useState(() => controller.snapshot)
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.snapshot))
    setSnapshot(controller.snapshot)
    return unsubscribe
  }, [controller])

  /* Unmount: the controller lets go of the BluetoothDevice listener, the session and its two timers. */
  useEffect(() => () => controller.dispose(), [controller])

  return { snapshot, controller }
}
