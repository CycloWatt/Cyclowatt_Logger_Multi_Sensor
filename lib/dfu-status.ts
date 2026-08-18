/**
 * "Is a firmware update running?" - answered from the two independent places that
 * know, and deliberately kept pure so it can be unit-tested (the repo has no
 * component test setup, so behaviour worth pinning has to live in lib/).
 *
 * The two sources answer different questions and both matter on a bench:
 *
 *   - THIS BROWSER: the DFU card's own in-flight flag. Covers the upload that is
 *     happening right now, in this tab, which the device itself cannot report.
 *   - THE DEVICE: the MCUboot image flags returned by an image-state read. Because
 *     this firmware runs safe boot (swap, test, self-confirm, auto-revert), an
 *     update is still "in progress" well after the upload finishes - an image can
 *     be staged for the next boot, or running its unconfirmed trial. Neither state
 *     was visible anywhere in the UI before.
 *
 * The trial-run case is the one worth surfacing: an image that is running but not
 * confirmed reverts on the next reset unless it self-confirms, so a board in that
 * state looks completely normal and is one power cycle away from changing version
 * underneath you.
 */

import type { ImageSlotState } from "@/lib/smp/client"

export interface DfuActivity {
  /** True when an update is underway somewhere - uploading, staged, or on trial. */
  running: boolean
  /** One line for the panel. Empty means "say nothing" - see the no-read case. */
  text: string
}

export function describeDfuActivity(slots: ImageSlotState[], flashInFlight: boolean): DfuActivity {
  // Checked first: during a flash the panel's read button is disabled, so `slots`
  // is whatever the last read left behind and is not evidence about now. This
  // branch is also the answer to "why are these buttons greyed out?".
  if (flashInFlight) {
    return {
      running: true,
      text: "A firmware update is running in this browser. Image state cannot be read until it finishes.",
    }
  }

  // No read has happened yet (or the last one failed and cleared the listing).
  // Stay silent rather than report "no update running" - that is a claim, and
  // nothing here has the evidence for it.
  if (slots.length === 0) return { running: false, text: "" }

  const staged = slots.find((slot) => slot.pending)
  if (staged) {
    return {
      running: true,
      text: `Update staged: slot ${staged.slot} (v${staged.version}) is marked for the next boot and has not booted yet.`,
    }
  }

  const trial = slots.find((slot) => slot.active && !slot.confirmed)
  if (trial) {
    return {
      running: true,
      text:
        `Update on trial: slot ${trial.slot} (v${trial.version}) is running but NOT confirmed. ` +
        "It reverts to the previous image on the next reset unless the board confirms it.",
    }
  }

  const settled = slots.find((slot) => slot.active && slot.confirmed)
  if (settled) {
    return {
      running: false,
      text: `No firmware update in progress. Running slot ${settled.slot} (v${settled.version}), confirmed.`,
    }
  }

  // Slots came back, but none of them claims to be the running image. Report the
  // negative without describing a running image we cannot identify.
  return { running: false, text: "No firmware update in progress." }
}
