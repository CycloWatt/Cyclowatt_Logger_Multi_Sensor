/**
 * The Trainer tab's display flush, re-exported from the one shared throttle.
 *
 * Bike-data notifications can arrive many times a second; a human reading the
 * panel cannot, so `queueDisplayUpdate`/`flushDisplay` throttled every state
 * write to at most once per DISPLAY_FLUSH_MS. That logic lived inline in
 * components/trainer-panel.tsx, coupled to `Date.now`/`setTimeout` and two
 * refs.
 *
 * The implementation now lives in lib/throttle.ts, because the raw-stream
 * tab's serial synchronization readout needed the SAME leading + trailing
 * machine and two copies would have drifted apart. This module stays as the
 * trainer's name for it so controller.ts keeps reading `./display-throttle`,
 * and so this WHY - and the leading-flush reasoning in lib/throttle.ts - is
 * one hop from the notification path it shapes.
 */

export * from "../throttle"
