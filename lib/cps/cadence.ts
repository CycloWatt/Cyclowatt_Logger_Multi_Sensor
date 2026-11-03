/** CPS crank counters use uint16 rollover and event times in 1/1024 seconds. */
export class ReferenceCadence {
  private previous: { revolutions: number; time: number } | null = null
  private rpm: number | null = null
  private lastMovement = 0

  reset() {
    this.previous = null
    this.rpm = null
    this.lastMovement = 0
  }

  /** Blank until two crank events; expire silence rather than logging stale RPM. */
  value(now: number): number | null {
    return now - this.lastMovement > 3000 ? null : this.rpm
  }

  update(view: DataView, now: number): number | null {
    if (view.byteLength < 4) return null
    const flags = view.getUint16(0, true)
    let offset = 4
    if (flags & 1) offset += 1 // pedal power balance
    if (flags & 4) offset += 2 // accumulated torque
    if (flags & 16) offset += 6 // wheel revolution data
    if (!(flags & 32) || view.byteLength < offset + 4) {
      // Optional crank data may be omitted between valid crank measurements.
      // Keep the baseline and let value() expire the last actual crank event.
      return this.value(now)
    }
    const current = { revolutions: view.getUint16(offset, true), time: view.getUint16(offset + 2, true) }
    const previous = this.previous
    this.previous = current
    // After a complete event-clock period, modulo arithmetic cannot tell how
    // many wraps elapsed. Reacquire two events rather than inventing an RPM.
    if (!previous || now - this.lastMovement >= 64_000) {
      this.rpm = null
      this.lastMovement = now
      return null
    }
    const revolutions = (current.revolutions - previous.revolutions + 65536) % 65536
    const elapsed = (current.time - previous.time + 65536) % 65536
    if (revolutions && elapsed) {
      this.rpm = revolutions * 60 * 1024 / elapsed
      this.lastMovement = now
    }
    return this.value(now)
  }
}
