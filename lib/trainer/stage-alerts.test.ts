import { describe, expect, it } from "vitest"
import { createRunner, reduceRunner } from "./protocol-runner"
import { stageAlert, StageSoundTracker } from "./stage-alerts"

const protocol = { name: "Test", steps: [
  { targetWatts: 100, targetCadenceRpm: 75, durationSeconds: 10 },
  { targetWatts: 200, targetCadenceRpm: 90, durationSeconds: 10, instruction: "Stand up" },
] }
const running = () => reduceRunner(createRunner(protocol), { type: "start" }, 1000).state

describe("stage alerts", () => {
  it("previews the next watts, cadence and instruction before a 3-2-1 countdown", () => {
    const state = running()
    expect(stageAlert(state, 7000)).toMatchObject({countdown:null, sound:null, secondsRemaining:4, step:protocol.steps[1]})
    expect([8000,9000,10000].map(t => stageAlert(state,t).countdown)).toEqual([3,2,1])
    expect(stageAlert(state,11000).sound).toBeNull()
  })
  it("bells when the runner commits the new target and never repeats on rerender", () => {
    const tracker = new StageSoundTracker()
    const state = running()
    const cue = stageAlert(state,8000)
    expect(tracker.take(state,cue)).toBe("beep")
    expect(tracker.take(state,cue)).toBeNull()
    const next = reduceRunner(state,{type:"tick"},11000).state
    const changed = stageAlert(next,11000)
    expect(changed).toMatchObject({phase:"changed",step:protocol.steps[1],sound:"bell"})
    expect(tracker.take(next,changed)).toBe("bell")
    expect(tracker.take(next,changed)).toBeNull()
  })
  it("freezes on pause, shifts the countdown on resume and avoids replaying cues", () => {
    const tracker = new StageSoundTracker()
    const initial = running()
    tracker.take(initial,stageAlert(initial,8000))
    const paused = reduceRunner(initial,{type:"pause"},8500).state
    expect(stageAlert(paused,20000)).toMatchObject({phase:"paused",secondsRemaining:3,sound:null})
    const resumed = reduceRunner(paused,{type:"resume"},20000).state
    expect(tracker.take(resumed,stageAlert(resumed,20000))).toBeNull()
    expect(stageAlert(resumed,20500).countdown).toBe(2)
  })
  it("announces a skipped stage but does not replay historical countdowns after a delay", () => {
    const skipped = reduceRunner(running(),{type:"skip"},5000).state
    expect(stageAlert(skipped,5000).sound).toBe("bell")
    const caughtUp = reduceRunner(running(),{type:"tick"},15000).state
    expect(stageAlert(caughtUp,15000)).toMatchObject({phase:"upcoming",sound:null,countdown:null})
  })
  it("counts down to finish, rings once, and stays silent after stop or a late finish", () => {
    const last = reduceRunner(running(),{type:"tick"},11000).state
    expect(stageAlert(last,18000)).toMatchObject({countdown:3,step:null,sound:"beep"})
    const finished = reduceRunner(last,{type:"tick"},21000).state
    expect(stageAlert(finished,21000)).toMatchObject({phase:"finished",sound:"bell"})
    expect(stageAlert(finished,25000).sound).toBeNull()
    const stopped = reduceRunner(last,{type:"stop"},18000).state
    expect(stageAlert(stopped,18000)).toMatchObject({phase:"idle",sound:null})
  })
  it("resets cue deduplication for a new run and handles cadence-only changes", () => {
    const tracker = new StageSoundTracker()
    const state = running()
    expect(tracker.take(state,stageAlert(state,8000))).toBe("beep")
    const restarted = reduceRunner(createRunner(protocol),{type:"start"},30000).state
    expect(tracker.take(restarted,stageAlert(restarted,37000))).toBe("beep")
    const cadenceOnly = { ...state, protocol:{name:"Cadence",steps:[protocol.steps[0],{...protocol.steps[1],targetWatts:100}]} }
    expect(stageAlert(cadenceOnly,8000).step?.targetCadenceRpm).toBe(90)
  })
})
