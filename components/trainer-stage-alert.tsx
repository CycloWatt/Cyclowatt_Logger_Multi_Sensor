"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type { RunnerState } from "@/lib/trainer/protocol-runner"
import { stageAlert, StageSoundTracker } from "@/lib/trainer/stage-alerts"

/** Short synthesized cues, with an envelope to avoid clicks and no downloaded assets. */
function playTone(context: AudioContext, bell: boolean, volume: number) {
  const frequencies = bell ? [880, 1320] : [660]
  for (const frequency of frequencies) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const start = context.currentTime
    const duration = bell ? 0.65 : 0.12
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(volume * (bell ? 0.12 : 0.18), start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    oscillator.start(start)
    oscillator.stop(start + duration + 0.02)
  }
}

export function TrainerStageAlert({ runner }: { runner: RunnerState }) {
  const [now, setNow] = useState(0)
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [volume, setVolume] = useState(0.6)
  const [audioError, setAudioError] = useState("")
  const contextRef = useRef<AudioContext | null>(null)
  const tracker = useRef(new StageSoundTracker())

  useEffect(() => {
    setNow(Date.now())
    if (runner.status !== "running") return
    const interval = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(interval)
  }, [runner.status])

  useEffect(() => () => { void contextRef.current?.close().catch(() => {}) }, [])

  const alert = stageAlert(runner, now || Date.now())
  useEffect(() => {
    const cue = tracker.current.take(runner, alert)
    if (!cue || !soundEnabled) return
    const context = contextRef.current
    if (!context || context.state !== "running") {
      setSoundEnabled(false)
      setAudioError("Sound was suspended. Enable sound again to resume cues.")
      return
    }
    try { playTone(context, cue === "bell", volume) }
    catch { setSoundEnabled(false); setAudioError("Sound is unavailable. The visual countdown remains active.") }
  }, [runner, alert.soundKey, soundEnabled, volume])

  async function enableSound() {
    try {
      const context = contextRef.current?.state !== "closed" && contextRef.current
        ? contextRef.current : new AudioContext()
      contextRef.current = context
      await context.resume()
      if (context.state !== "running") throw new Error("Audio blocked")
      setSoundEnabled(true)
      setAudioError("")
      playTone(context, true, volume)
    } catch {
      setSoundEnabled(false)
      setAudioError("Could not enable sound. Check browser audio permissions; the visual countdown still works.")
    }
  }

  const title = alert.phase === "paused" ? "Protocol paused"
    : alert.phase === "finished" ? "Protocol complete"
    : alert.phase === "changed" ? "Stage started — now"
    : alert.phase === "idle" ? "Stage alerts"
    : alert.step ? "Up next" : "Finish in"
  return (
    <section aria-label="Protocol stage alerts" className={`rounded-xl border p-4 sm:p-6 ${alert.countdown !== null ? "border-amber-400 bg-amber-50" : alert.phase === "changed" || alert.phase === "finished" ? "border-emerald-300 bg-emerald-50" : "border-blue-200 bg-blue-50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" aria-pressed={soundEnabled}
            onClick={() => soundEnabled ? setSoundEnabled(false) : void enableSound()}>
            {soundEnabled ? "Mute stage sounds" : "Enable sound"}
          </Button>
          <label className="flex items-center gap-2 text-sm">Volume
            <input aria-label="Stage sound volume" type="range" min="0" max="1" step="0.1" value={volume}
              onChange={event => setVolume(Number(event.target.value))} className="w-24" />
          </label>
          {soundEnabled && <Button size="sm" variant="ghost" onClick={() => void enableSound()}>Test sound</Button>}
        </div>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="mt-3 flex items-center gap-5">
        {alert.countdown !== null && <span className="text-6xl font-bold tabular-nums sm:text-7xl">{alert.countdown}</span>}
        <div>
          {alert.phase === "finished" ? <p className="text-2xl font-semibold">Well done — protocol finished.</p>
            : alert.step && alert.phase !== "idle" ? <>
              <p className="text-2xl font-semibold sm:text-3xl">{alert.step.targetWatts} W
                {alert.step.targetCadenceRpm !== undefined && ` · ${alert.step.targetCadenceRpm} rpm`}</p>
              {alert.step.instruction && <p className="mt-1 text-lg">{alert.step.instruction}</p>}
            </> : <p>{alert.phase === "idle" ? "Three countdown beeps before each stage change, then a bell at the change." : "End of protocol"}</p>}
          {alert.phase === "upcoming" && alert.countdown === null && <p className="mt-1 text-sm">{alert.secondsRemaining} seconds remaining</p>}
          {alert.phase === "paused" && <p className="mt-1 text-sm">Countdown and sounds resume with the protocol.</p>}
        </div>
      </div>
      {audioError && <p role="alert" className="mt-2 text-sm text-amber-800">{audioError}</p>}
      <p className="mt-2 text-xs text-gray-600">Enable sound plays a preview. Keep this page visible and your device awake for timely cues.</p>
    </section>
  )
}
