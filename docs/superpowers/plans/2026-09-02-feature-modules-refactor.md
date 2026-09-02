# Feature-Modules Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the two oversized client files (`components/trainer-panel.tsx`, 1318 lines; `app/page.tsx`, 2133 lines) into a sustainable architecture with byte-identical behaviour: same BLE writes in the same order, same log rows, same CSV, same UI.

**Architecture:** Orchestration moves out of React into a `TrainerController` class in `lib/trainer/controller.ts` (injected collaborators, plain-data snapshot, `subscribe`), bound to React by one thin hook `hooks/use-trainer-controller.ts`; the panel becomes a composition root over three new flat cards. Pure helpers (targets, labels, log context, the runner-event → control-op plan, throttle, chart buffer) move to `lib/trainer/` first, each with vitest tests, so most of today's untested panel logic becomes unit-tested in the existing node-only vitest setup. `app/page.tsx` loses only its safest slices: pure helpers to `lib/` with tests, then (if time allows) the serial-sync input and the CPS measurement parser.

**Tech Stack:** Next.js 14 static export, React 18, TypeScript strict (`isolatedModules`), vitest 4 (node environment, no DOM), shadcn/ui. **No new dependencies.**

**Spec:** `.superpowers/sdd/rework-kickoff.md` (mandate + guardrails) and the architecture design recorded in `.superpowers/sdd/refactor-feature-modules/design.md`.

## Global Constraints

- Behaviour-preserving only: no new features, no renamed CSV columns, no changed BLE opcode order, no changed log-row text or order, no changed `disabled` conditions. If a step needs a behaviour change to be clean, STOP that step and record it in the report instead.
- No new npm dependencies; no `vitest.config.*`; tests run in plain node (`npx vitest run <file>`).
- `lib/` imports no React and no component. Dependency direction `components/ → hooks/ → lib/`.
- Every task ends green on `npx vitest run` and `npx tsc --noEmit -p tsconfig.json`; tasks marked **BUILD** also run `npm run build` (static export must prerender).
- TDD for every new `lib/` module: test first, watch it fail, then move/implement.
- Style: header comments explain WHY (see `lib/cps/protocol.ts`, `components/calibration-card.tsx`); commit style `type(scope): imperative sentence` with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; commit only your own files; retry on `index.lock`.
- Two tracks run in parallel on the same branch: the **panel track** (Tasks 1–12, all touch `components/trainer-panel.tsx`, strictly sequential) and the **page track** (Tasks 13–15, touch `app/page.tsx` and new `lib/` files, sequential). Never touch the other track's files.
- `lib/trainer/{protocol-runner,session-log,presets,format}.ts`, `lib/ftms/*`, `components/trainer-{readouts,chart,step-editor,manual-controls}.tsx` are untouched except where a task says so.
- Public `TrainerPanelProps { bluetoothAvailable: boolean; boardDeviceId: string | null }` is unchanged; `app/page.tsx`'s trainer hook-up lines are unchanged.

---

## Behaviour oracle (reviewers trace against this)

Full inventory in `.superpowers/sdd/refactor-feature-modules/design.md` §A. Key invariants:

- `sendControl` never throws; no session → `false` and **no** log row; success row `"<label> -> success"`; 0x05 (control not permitted) → Request Control, `markControl(true)`, if `restartAfterRetake !== false` then `startedRef=false`, 0x07, `startedRef=true`; re-run; row `"<label> -> success after re-taking control[ and re-starting]"`; retry failure → `markControl(false)`, `startedRef=false`, row `"<label> -> failed after re-taking control: <msg>"`, error `"<label> failed: <msg>"`.
- `applyEvents`: (1) rows first in event order (`step-started` → `"step <i+1> target <W> W"`, `resumed` → `"target <W> W"`, others `""`); (2) `send:false` or no session → return; (3) finishing: `watts = clampToRange(50, powerRange)`, `stopping`, `needsRestart = !startedRef`, if stopping `startedRef=false` synchronously; async chain `[0x07 if needsRestart (abort all on failure; startedRef=true only if !stopping)] → 0x05 50 W → [0x08 STOP if stopping, restartAfterRetake:false]`; (4) else if runner status after commit `!== "paused"` → 0x05 for the LAST `step-started`/`resumed`; (5) `paused` present → 0x08 PAUSE (`restartAfterRetake:false`), then `startedRef=false`.
- Bike-data notification: liveRef ← sample; chartStartMs ??= now; target computed from mode/runner/manualTargetSent; chart point pushed + trimmed to 600; **if recording && log → appendSample** (before the tick); `tickRunner(now)`; queue display flush.
- Row orders: control lost → `status` row, then `control-lost`, then `paused` (if running). Link lost → `paused` (if running) then `disconnected: "link lost"`. Operator disconnect → dispose, gatt.disconnect, `paused` (if running), `disconnected: "disconnected by the operator"`.
- Display throttle: flush immediately if `now - lastFlush >= 250`, else one deferred 250 ms flush; flush sets `lastFlush` first and hands the chart a NEW array.

---

## Panel track

### Task 1: `lib/trainer/targets.ts`

**Files:**
- Create: `lib/trainer/targets.ts`, `lib/trainer/targets.test.ts`
- Modify: `components/trainer-panel.tsx` (remove `FINISH_TARGET_W` ~L114, `protocolTargetW` ~L146, `resistanceTenthsFromPct` ~L157, the `liveTargetW` ternary ~L1086; import instead)

**Interfaces — Produces:**
```ts
export const FINISH_TARGET_W = 50
export function protocolTargetW(state: RunnerState, nowMs: number): number | null
export function resistanceTenthsFromPct(pct: number, range: SupportedRange): number
export type ManualTargetSent = "power" | "resistance" | null
export function liveTargetW(a: { mode: TrainerMode; runner: RunnerState; nowMs: number; manualTargetSent: ManualTargetSent; manualTargetW: number }): number | null
```

- [ ] **Step 1: Write the failing test** `lib/trainer/targets.test.ts`
```ts
import { describe, expect, it } from "vitest"
import { createRunner, reduceRunner } from "./protocol-runner"
import { FINISH_TARGET_W, liveTargetW, protocolTargetW, resistanceTenthsFromPct } from "./targets"

const protocol = { name: "p", steps: [{ targetWatts: 150, durationSeconds: 60 }, { targetWatts: 200, durationSeconds: 60 }] }

describe("protocolTargetW", () => {
  it("is null while idle", () => expect(protocolTargetW(createRunner(protocol), 0)).toBeNull())
  it("is the current step's watts while running and paused", () => {
    const { state: running } = reduceRunner(createRunner(protocol), { type: "start" }, 1000)
    expect(protocolTargetW(running, 1000)).toBe(150)
    const { state: paused } = reduceRunner(running, { type: "pause" }, 2000)
    expect(protocolTargetW(paused, 2000)).toBe(150)
  })
  it("is null once finished or stopped, even though runnerView still reports watts", () => {
    const { state: running } = reduceRunner(createRunner(protocol), { type: "start" }, 0)
    const { state: stopped } = reduceRunner(running, { type: "stop" }, 10)
    expect(protocolTargetW(stopped, 10)).toBeNull()
    const { state: finished } = reduceRunner(running, { type: "tick" }, 200_000)
    expect(protocolTargetW(finished, 200_000)).toBeNull()
  })
})

describe("resistanceTenthsFromPct", () => {
  it("maps 0 and 100 % onto the published range when it fits a uint8", () => {
    const range = { min: 0, max: 200, increment: 10 }
    expect(resistanceTenthsFromPct(0, range)).toBe(0)
    expect(resistanceTenthsFromPct(100, range)).toBe(200)
    expect(resistanceTenthsFromPct(50, range)).toBe(100)
  })
  it("clips the ceiling to 255 tenths, the uint8 the wire carries", () => {
    const range = { min: 0, max: 1000, increment: 10 }
    expect(resistanceTenthsFromPct(100, range)).toBe(250)
    expect(resistanceTenthsFromPct(50, range)).toBe(130)
  })
})

describe("liveTargetW", () => {
  const idle = createRunner(protocol)
  it("follows the runner in protocol mode", () => {
    const { state: running } = reduceRunner(idle, { type: "start" }, 0)
    expect(liveTargetW({ mode: "protocol", runner: running, nowMs: 0, manualTargetSent: null, manualTargetW: 999 })).toBe(150)
    expect(liveTargetW({ mode: "protocol", runner: idle, nowMs: 0, manualTargetSent: "power", manualTargetW: 999 })).toBeNull()
  })
  it("shows the manual power target only once it has been sent", () => {
    expect(liveTargetW({ mode: "manual-power", runner: idle, nowMs: 0, manualTargetSent: null, manualTargetW: 120 })).toBeNull()
    expect(liveTargetW({ mode: "manual-power", runner: idle, nowMs: 0, manualTargetSent: "power", manualTargetW: 120 })).toBe(120)
  })
  it("is null in resistance mode", () => {
    expect(liveTargetW({ mode: "manual-resistance", runner: idle, nowMs: 0, manualTargetSent: "resistance", manualTargetW: 120 })).toBeNull()
  })
  it("lands finished protocols at 50 W", () => expect(FINISH_TARGET_W).toBe(50))
})
```
- [ ] **Step 2: Run** `npx vitest run lib/trainer/targets.test.ts` → FAIL "Cannot find module './targets'".
- [ ] **Step 3: Create `lib/trainer/targets.ts`** by MOVING the three functions/constant and their doc comments verbatim from the panel (import `RunnerState`, `runnerView` from `./protocol-runner`, `SupportedRange`, `clampToRange` from `../ftms/protocol`, `TrainerMode` from `./session-log`), plus `liveTargetW` implementing exactly the panel's ternary (`mode === "protocol" ? protocolTargetW(runner, nowMs) : mode === "manual-power" && manualTargetSent === "power" ? manualTargetW : null`). Header comment: why targets are "what is on the wire", not "what the mode would send".
- [ ] **Step 4: Rewire the panel**: delete the moved definitions, import from `@/lib/trainer/targets`, replace the `liveTargetW` ternary with `liveTargetW({ mode, runner, nowMs: nowTick || Date.now(), manualTargetSent, manualTargetW })`. Keep `nowTick || Date.now()` exactly.
- [ ] **Step 5: Run** the test (PASS), `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 6: Commit** `refactor(trainer): move target helpers into lib/trainer/targets`.

### Task 2: `lib/trainer/labels.ts`

**Files:** Create `lib/trainer/labels.ts`, `lib/trainer/labels.test.ts`; Modify `components/trainer-panel.tsx` (~L1080 `stale`, ~L1093–1112 `targetLabel`/`stepLabel`/`elapsedLabel`).

**Produces:**
```ts
export const STALE_MS = 3000
export function isStale(receivedAtMs: number | null, nowMs: number, staleMs?: number): boolean
export function targetLabel(a: { mode: TrainerMode; manualTargetSent: ManualTargetSent; manualResistancePct: number; liveTargetW: number | null }): string
export function stepLabel(a: { mode: TrainerMode; runnerStatus: RunnerStatus; stepIndex: number; stepCount: number }): string
export function elapsedLabel(a: { mode: TrainerMode; runnerStatus: RunnerStatus; totalElapsedS: number; protocolDurationS: number; recording: boolean; logStartedAtMs: number | null; nowMs: number }): string
```

- [ ] **Step 1: Failing test** `lib/trainer/labels.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { elapsedLabel, isStale, STALE_MS, stepLabel, targetLabel } from "./labels"

describe("isStale", () => {
  it("is false without a reading and within the window", () => {
    expect(isStale(null, 10_000)).toBe(false)
    expect(isStale(7_500, 10_000)).toBe(false)
  })
  it("is true once STALE_MS has passed", () => expect(isStale(10_000 - STALE_MS - 1, 10_000)).toBe(true))
})

describe("targetLabel", () => {
  it("shows resistance percent only after it was sent", () => {
    expect(targetLabel({ mode: "manual-resistance", manualTargetSent: "resistance", manualResistancePct: 35, liveTargetW: null })).toBe("35 %")
    expect(targetLabel({ mode: "manual-resistance", manualTargetSent: null, manualResistancePct: 35, liveTargetW: null })).toBe("–")
  })
  it("shows watts or a dash otherwise", () => {
    expect(targetLabel({ mode: "protocol", manualTargetSent: null, manualResistancePct: 0, liveTargetW: 200 })).toBe("200 W")
    expect(targetLabel({ mode: "manual-power", manualTargetSent: null, manualResistancePct: 0, liveTargetW: null })).toBe("–")
  })
})

describe("stepLabel", () => {
  it("is Manual outside protocol mode, a dash while idle, else Step i / n", () => {
    expect(stepLabel({ mode: "manual-power", runnerStatus: "running", stepIndex: 0, stepCount: 3 })).toBe("Manual")
    expect(stepLabel({ mode: "protocol", runnerStatus: "idle", stepIndex: 0, stepCount: 3 })).toBe("–")
    expect(stepLabel({ mode: "protocol", runnerStatus: "running", stepIndex: 1, stepCount: 3 })).toBe("Step 2 / 3")
  })
})

describe("elapsedLabel", () => {
  const base = { mode: "protocol" as const, runnerStatus: "running" as const, totalElapsedS: 65, protocolDurationS: 600, recording: false, logStartedAtMs: null, nowMs: 100_000 }
  it("shows protocol elapsed / total while the runner is not idle", () => expect(elapsedLabel(base)).toBe("01:05 / 10:00"))
  it("shows recorded time when recording with a log, outside a running protocol", () => {
    expect(elapsedLabel({ ...base, mode: "manual-power", recording: true, logStartedAtMs: 100_000 - 125_000 })).toBe("02:05 recorded")
  })
  it("needs BOTH recording and a log", () => {
    expect(elapsedLabel({ ...base, mode: "manual-power", recording: true, logStartedAtMs: null })).toBe("–")
    expect(elapsedLabel({ ...base, mode: "manual-power", recording: false, logStartedAtMs: 0 })).toBe("–")
  })
})
```
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** by moving the panel's expressions verbatim into these functions (`mmss` from `./format`). `isStale(received, now)` = `received !== null && now - received > STALE_MS`.
- [ ] **Step 4: Rewire the panel**: `const stale = isStale(live?.receivedAtMs ?? null, nowTick)`; `targetLabel({...})`, `stepLabel({ mode, runnerStatus: runner.status, stepIndex: view.stepIndex, stepCount: view.stepCount })`, `elapsedLabel({ mode, runnerStatus: runner.status, totalElapsedS: view.totalElapsedS, protocolDurationS: protocolDurationSeconds(runner.protocol), recording, logStartedAtMs: logRef.current?.startedAtMs ?? null, nowMs: nowTick || Date.now() })`. Remove the local `STALE_MS`.
- [ ] **Step 5: Run** test, full vitest, tsc. **Step 6: Commit** `refactor(trainer): move readout labels into lib/trainer/labels`.

### Task 3: `lib/trainer/mode.ts`

**Files:** Create `lib/trainer/mode.ts`; Modify `components/trainer-manual-controls.tsx` (replace the local `ManualSubMode` definition with `export type { ManualSubMode } from "@/lib/trainer/mode"` — type-only, `isolatedModules`), `components/trainer-panel.tsx` (import from lib).

- [ ] **Step 1:** `lib/trainer/mode.ts`: `export type { TrainerMode } from "./session-log"`; `export type ManualSubMode = "power" | "resistance"`; `export function manualModeFor(sub: ManualSubMode): TrainerMode` (`"power" → "manual-power"`, `"resistance" → "manual-resistance"`) and `export function subModeFor(mode: TrainerMode): ManualSubMode` (`"manual-resistance" → "resistance"`, else `"power"`) — ONLY if the panel already has these mappings inline (it does in `handleSubModeChange` and the `subMode` prop); move them, do not invent.
- [ ] **Step 2:** Tiny test `lib/trainer/mode.test.ts` for the two mappings (write first, watch fail).
- [ ] **Step 3:** Rewire both components. tsc clean, vitest green. **Commit** `refactor(trainer): give the trainer mode types one home`.

### Task 4: `lib/trainer/log-context.ts` — **BUILD**

**Files:** Create `lib/trainer/log-context.ts`, `.test.ts`; Modify panel (~L237–247 `logProtocolName`, `logStepIndex`).

**Produces:** `logProtocolName(mode: TrainerMode, protocolName: string): string`; `logStepIndex(mode: TrainerMode, runner: RunnerState): number | null`.

- [ ] **Step 1: Failing test**: blank name unless mode is protocol; index null unless protocol mode AND running/paused; index equals `runner.stepIndex` otherwise (build states with `createRunner`/`reduceRunner`).
- [ ] **Step 2: Run** → FAIL. **Step 3:** move the two functions (pure, parameters instead of refs). **Step 4:** every call site in the panel passes `modeRef.current` / `protocolNameRef.current` / `runnerRef.current` (ref values on the notification path, never state). **Step 5:** vitest, tsc, `npm run build`. **Step 6: Commit** `refactor(trainer): move log-row context helpers into lib`.

### Task 5: `lib/trainer/control-plan.ts` — the oracle

**Files:** Create `lib/trainer/control-plan.ts`, `.test.ts`; Modify panel `applyEvents` (~L385–470) → plan + interpreter.

**Produces:**
```ts
export interface PlannedRow { event: LogEventKind; detail: string }
export type PlannedOp =
  | { kind: "start"; label: string; markStartedOnSuccess: boolean }        // 0x07
  | { kind: "targetPower"; label: string; watts: number }                    // 0x05
  | { kind: "stop"; label: string }                                          // 0x08 STOP, restartAfterRetake:false
  | { kind: "pause"; label: string }                                         // 0x08 PAUSE, restartAfterRetake:false, then started=false
export interface PlanInput { events: RunnerEvent[]; started: boolean; powerRange: SupportedRange; runnerStatusAfter: RunnerStatus; send: boolean }
export interface ControlPlan { rows: PlannedRow[]; ops: PlannedOp[]; startedBeforeOps: boolean; abortChainOnStartFailure: boolean }
export function planRunnerEffects(input: PlanInput): ControlPlan
```
Semantics (from the oracle): rows always; `send:false` → `ops: []`. finishing: `startedBeforeOps = stopping ? false : started`; ops = `[start{label:"Start or Resume (for the protocol-end target)", markStartedOnSuccess: !stopping}]` if `!started`, then `targetPower{label:"Set Target Power 50 W (protocol end)", watts: clampToRange(50, powerRange)}`, then `stop{label:"Stop"}` if stopping; `abortChainOnStartFailure = true`. Else if `runnerStatusAfter !== "paused"` and a `step-started`/`resumed` exists → one `targetPower{label:"Set Target Power <W> W", watts}` for the LAST such event. If a `paused` event exists → append `pause{label:"Pause"}`. Labels must be copied from the panel verbatim (check the exact strings there first).

- [ ] **Step 1: Failing test** — one `it` per oracle row: start (1 row + 1 targetPower), pause (row + pause op, startedBeforeOps unchanged), resume (row `"target 150 W"` + targetPower), skip running, skip paused (row, NO ops), skip-last from running (`finished` row + [targetPower 50]), skip-last from paused (`started:false` → [start(markStartedOnSuccess:true), targetPower 50]), stop from running (`stopped` row, `startedBeforeOps:false`, [targetPower 50, stop]), stop from paused ([start(markStartedOnSuccess:false), targetPower 50, stop]), multi-boundary tick (3 `step-started` rows, ONE targetPower for the last), `send:false` (rows, no ops), powerRange min 80 → finish target 80.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement. **Step 4:** panel `applyEvents` becomes: compute `plan = planRunnerEffects({ events, started: startedRef.current, powerRange, runnerStatusAfter: runnerRef.current.status, send: send && !!sessionRef.current })`; write rows via `logEvent(row.event, row.detail, nowMs)`; `startedRef.current = plan.startedBeforeOps`; then ONE async IIFE walking `plan.ops` in order: `start` → `sendControl(label, () => session.start())`, on failure return if `abortChainOnStartFailure`, on success `if (markStartedOnSuccess) startedRef.current = true`; `targetPower` → `sendControl(label, () => session.setTargetPower(watts))`; `stop` → `sendControl(label, () => session.stop(), { restartAfterRetake: false })`; `pause` → `sendControl("Pause", () => session.pause(), { restartAfterRetake: false })` then `startedRef.current = false`. Compare with the old code line by line: the old phase-4 target send and the phase-5 pause were NOT awaited in one chain — check whether they were sequential `void` calls; preserve the exact awaiting structure (if the old code fired pause without awaiting the target, keep two independent `void sendControl` calls for those two op kinds instead of one chain). Record what you found in your report.
- [ ] **Step 5:** vitest, tsc. **Step 6: Commit** `refactor(trainer): plan runner effects as data in lib/trainer/control-plan`.

### Task 6: `lib/trainer/display-throttle.ts` + `lib/trainer/chart-buffer.ts` — **BUILD**

**Produces:**
```ts
// display-throttle.ts
export interface ThrottleDeps { intervalMs: number; now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void; onFlush: (nowMs: number) => void }
export function createThrottle(deps: ThrottleDeps): { queue(): void; cancel(): void }
// chart-buffer.ts
export const CHART_MAX_POINTS = 600
export interface TrainerChartPoint { t: number; power: number | null; target: number | null; cadence: number | null }  // move from trainer-chart.tsx; the component re-exports the type
export function appendChartPoint(buffer: TrainerChartPoint[], point: TrainerChartPoint, maxPoints?: number): void
```
- [ ] **Step 1: Failing tests** (`vi.useFakeTimers()` for the throttle): first `queue()` flushes immediately (lastFlush was 0); a second `queue()` within 250 ms schedules exactly ONE deferred flush at +250 ms even if `queue()` is called five more times; after the deferred flush, `lastFlush` is the flush time so a `queue()` 300 ms later flushes immediately; `cancel()` drops a pending deferred flush. Chart buffer: 601st point drops the first; `maxPoints` default 600.
- [ ] **Step 2:** FAIL → implement (throttle mirrors `queueDisplayUpdate`/`flushDisplay` exactly: `if (now - last >= interval) { last = now; onFlush(now) } else if (!timer) timer = setTimer(() => { timer = null; last = now(); onFlush(last) }, interval)`).
- [ ] **Step 3:** panel: `throttleRef = useRef(createThrottle({ intervalMs: 250, now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout, onFlush: flushDisplayBody }))` where `flushDisplayBody` does what `flushDisplay` did minus the `lastFlushRef` write; `queueDisplayUpdate` → `throttleRef.current.queue()`; unmount → `cancel()`. Chart push+splice → `appendChartPoint`. `TrainerChartPoint` imported from lib in both the panel and `trainer-chart.tsx` (`export type { TrainerChartPoint }` there).
- [ ] **Step 4:** vitest, tsc, build. **Commit** `refactor(trainer): extract display throttle and chart buffer into lib`.

### Task 7: `lib/trainer/controller.ts` — control-point and runner layers

**Files:** Create `lib/trainer/controller.ts`, `lib/trainer/controller.test.ts`; Modify panel to delegate (`sessionRef`, `hasControlRef`, `startedRef`, `markControl`, `markManualTargetSent`, `logEvent`, `sendControl`, `ensureStarted`, `takeControl`, `commitRunner`, `tickRunner`, plan interpreter, `startProtocol`, `dispatchRunner`, `resumeProtocol` move in; the panel keeps React state mirrors updated via `subscribe`).

**Produces (final shape; Task 8 adds the remaining methods):**
```ts
export interface TrainerSnapshot {
  connecting: boolean; connected: boolean; deviceName: string; hasDevice: boolean
  capabilities: FtmsCapabilities | null; hasControl: boolean; error: string
  mode: TrainerMode; manualTargetW: number; manualResistancePct: number; manualTargetSent: ManualTargetSent
  runner: RunnerState; starting: boolean
  steps: ProtocolStep[]; protocolName: string
  recording: boolean; sampleCount: number; hasLog: boolean; logStartedAtMs: number | null
  live: LiveSample | null; chartData: TrainerChartPoint[]; trainerReportedTargetW: number | null
}
export interface TrainerControllerDeps {
  openSession: typeof openFtmsSession
  requestDevice: (options: RequestDeviceOptions) => Promise<BluetoothDevice>   // Task 8
  boardDeviceId: () => string | null
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  log?: Pick<Console, "log" | "warn" | "error">
}
export class TrainerController {
  constructor(deps: TrainerControllerDeps)
  get snapshot(): TrainerSnapshot
  subscribe(listener: () => void): () => void
  // control-point layer
  takeControl(): Promise<void>
  // runner layer
  setSteps(steps: ProtocolStep[]): void; setProtocolName(name: string): void
  startProtocol(): Promise<void>; dispatchRunner(action: RunnerAction): void; resumeProtocol(): Promise<void>; tick(nowMs: number): void
  // for tests and Task 8: attachSession(session: FtmsSession, deviceName: string): void  (does what openSession did after openFtmsSession returned, minus device listener wiring)
  // Task 8 adds: connect, reconnect, disconnect, dispose, setManualTargetW, setManualResistancePct, changeMode, onBikeData/onStatus/onControlLost, recording methods, csvForExport
}
```
Rules: private fields replace today's refs one-for-one (`session`, `hasControl`, `started`, `manualTargetSent`, `runner`, `starting`, `log`, `recording`, `live`, `chartBuffer`, `chartStartMs`); `snapshot` is a plain object rebuilt on every change (`this.emit()`), NEVER mutated in place; `emit()` is called only from event handlers/timers, never during render.

- [ ] **Step 1: Failing test** `controller.test.ts` using a fake `FtmsSession`-shaped object (structural: `{ capabilities, requestControl, start, stop, pause, setTargetPower, setTargetResistance, reset, dispose }` recording an ordered `calls: string[]` and able to reject a call with `new FtmsControlError(...)`) and `createSessionLog` so rows can be asserted:
  - `takeControl` writes `["requestControl"]`, snapshot `hasControl` true, row `control-result: "Request Control -> success"`.
  - `startProtocol` with 2 steps: `["requestControl","start","setTargetPower:150"]`, rows `[step-started "step 1 target 150 W", …control-result rows…]`.
  - pause → `["pause"]`; resume → `["start","setTargetPower:150"]` (started was cleared by pause).
  - skip while paused → row `step-started`, NO call. stop from paused → `["start","setTargetPower:50","stop"]`.
  - `setTargetPower` rejecting once with `CONTROL_NOT_PERMITTED` → `["setTargetPower:150","requestControl","start","setTargetPower:150"]`, row `"Set Target Power 150 W -> success after re-taking control and re-starting"`.
  - pause rejecting with `CONTROL_NOT_PERMITTED` → `["pause","requestControl","pause"]` (no restart), row `"Pause -> success after re-taking control"`.
  - no session → `takeControl` is a no-op with NO row.
  - `tick` past a boundary emits one `setTargetPower` for the last step only.
- [ ] **Step 2:** FAIL → **Step 3:** implement by moving the panel code (keep every label string and row text identical). **Step 4:** panel constructs the controller once in a ref (`useRef<TrainerController | null>(null)`, lazily), subscribes in an effect and mirrors `snapshot` into ONE `useState`; the moved functions are deleted from the panel and replaced by `controller.*` calls; everything not yet moved (connect/disconnect, notifications, recording, manual, mode) stays in the panel but reads/writes through the controller's public fields where they used refs — if that coupling is too invasive for this step, keep a temporary `controller.internal` accessor and record it (Task 8 removes it).
- [ ] **Step 5:** vitest, tsc. **Commit** `refactor(trainer): move control-point and runner orchestration into TrainerController`.

### Task 8: controller — notifications, recording, manual, mode, connection lifecycle — **BUILD**

**Files:** Modify `lib/trainer/controller.ts`, `.test.ts`, panel.

- [ ] **Step 1: Failing tests** (extend `controller.test.ts`):
  - bike-data with recording on: `samples.length` 1 BEFORE the runner boundary tick effect (sample records the outgoing step at a boundary); chart buffer trimmed at 600; `live` set.
  - status `targetPowerChanged 200` → row `status: {"kind":"targetPowerChanged","watts":200}`, snapshot `trainerReportedTargetW` 200.
  - control lost while running → rows in order `status`, `control-lost "the trainer revoked control"`, `paused`; `hasControl` false; NO calls; `error` text `"The trainer revoked control (another app took it). Press Take Control to continue."`.
  - `changeMode("manual-power")` while connected → `["requestControl"?,"start","setTargetPower:100"]` + row `target-set "100 W (manual)"`; `changeMode` to same mode → nothing; not connected → nothing sent, `manualTargetSent` null.
  - `setManualTargetW` debounced 150 ms (fake timers): three quick calls → one `setTargetPower` with the last value.
  - `setManualResistancePct(100)` with range max 1000 → `setTargetResistance:250`, row `"100 % -> 25 resistance level (manual)"` (copy the exact detail format from the panel).
  - link lost (`onLinkLost()`) while running → rows `paused`, `disconnected "link lost"`, session disposed, `connected` false, `deviceName` kept.
  - `disconnect()` → `dispose` called before `gatt.disconnect`, rows `paused` (if running) then `disconnected "disconnected by the operator"`, snapshot cleared (`hasDevice` false, capabilities null).
  - `connect()` with an injected `requestDevice`: rejects a CycloWatt board by name and by `boardDeviceId` with the exact 3-sentence error and touches nothing; `TypeError` from the first `requestDevice` → second plain call; success → `["requestControl"]`, row `connected "<name>"`, `console.log("Trainer capabilities", …)` called once.
  - `reconnect()` with a paused protocol → `["requestControl","start","setTargetPower:150"]` + row `target-set "150 W (re-sent after reconnect)"`.
  - recording start/stop/clear/export: `csvForExport()` null with no samples; filename via `sessionLogFilename(mode==="protocol"?protocolName:"", startedAtMs)`; `session-start` detail `"recording started, not connected"` / `"recording started, <name> connected"`.
  - `dispose()` removes the device listener, disposes the session, cancels throttle and manual timers, appends no row.
- [ ] **Step 2:** FAIL → **Step 3:** move the remaining panel logic in. The device's `gattserverdisconnected` listener is added/removed by the controller (remove-then-add on attach; removed in `disconnect()` and `dispose()`). **Step 4:** panel now holds NO refs except the controller instance; it keeps only: the presets effect, the `[runner.status]` interval + `visibilitychange` effect (calls `controller.tick(Date.now())`), the `[connected, hasReading]` 1 s `nowTick` effect, and the unmount effect (`controller.dispose()` — in the SAME unmount effect as today, not a `[]` StrictMode-double-mount trap; document why). Delete `useLatestRef`.
- [ ] **Step 5:** vitest, tsc, build. **Commit** `refactor(trainer): complete TrainerController with notifications, recording and connection lifecycle`.

### Task 9: `hooks/use-trainer-controller.ts` — **BUILD**

**Files:** Create `hooks/use-trainer-controller.ts`; Modify panel.

**Produces:** `export function useTrainerController(o: { bluetoothAvailable: boolean; boardDeviceId: string | null }): { snapshot: TrainerSnapshot; controller: TrainerController }`.

- [ ] **Step 1:** Move the lazy construction (`deps`: `openSession: openFtmsSession`, `requestDevice: (opts) => navigator.bluetooth.requestDevice(opts)`, `boardDeviceId: () => boardDeviceIdRef.current`, `now: Date.now`, `setTimer: setTimeout`, `clearTimer: clearTimeout`), the subscribe/mirror effect, and the unmount `dispose` into the hook. `boardDeviceId` is read through a ref updated in an effect so the controller sees the latest prop without re-construction. The hook contains no other logic.
- [ ] **Step 2:** Panel: one `useTrainerController` call; keep the timer effects and presets effect in the panel.
- [ ] **Step 3:** vitest, tsc, build. **Commit** `refactor(trainer): bind TrainerController to React through one hook`.

### Task 10: flat cards — **BUILD**

**Files:** Create `components/trainer-connection-card.tsx`, `components/trainer-run-card.tsx`, `components/trainer-recording-card.tsx`; Modify panel.

- [ ] **Step 1:** Move JSX verbatim; props are plain values + callbacks (`onConnect`, `onReconnect`, `onDisconnect`, `onTakeControl`; `onStart/onPause/onResume/onSkip/onStop`; `onStartRecording/onStopRecording/onClear/onExport`). Every `disabled` expression is copied character for character (list them in the report with before/after).
- [ ] **Step 2:** tsc, vitest, build; panel ≤ ~250 lines. **Commit** `refactor(trainer): split the trainer panel into connection, run and recording cards`.

### Task 11: panel header comment + design doc note

- [ ] Rewrite the panel's module comment to describe the composition-root role and point to `lib/trainer/controller.ts` for the ONE DISCIPLINE (now a property of the class, not a convention). Add a short "Architecture" section to `docs/superpowers/plans/2026-09-02-feature-modules-refactor.md`? — NO (plans are not docs). Instead add 10 lines to the header of `lib/trainer/controller.ts` explaining the snapshot/subscribe contract. **Commit** `docs(trainer): explain the controller/hook/panel split`.

### Task 12: panel-track verification

- [ ] `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`; record outputs in `.superpowers/sdd/refactor-feature-modules/verify-panel-track.md`; no commit unless something needed fixing.

---

## Page track (parallel; touches `app/page.tsx` and new `lib/` files only)

### Task 13: `app/page.tsx` pure helpers → `lib/` — **BUILD**

**Files:**
- Create `lib/bench-prefs.ts` (+ test), `lib/raw-stream/packet.ts` (+ test), `lib/raw-stream/csv.ts` (+ test)
- Modify `app/page.tsx` (prefs block ~L60–86; `EXPECTED_PACKET_SIZE`, `DataPoint`, `parseDataPacket` ~L88–110 and ~L1385–1473; CSV headers/rows ~L1575–1643 — the `DEBUG_PACKET_LOG` block and the Blob dance stay in the page)

**Produces:**
```ts
// lib/bench-prefs.ts
export const BENCH_PREFS_KEY: string   // exact existing key
export interface BenchPrefs { /* exact existing fields */ }
export function readBenchPrefs(store?: StringStore): BenchPrefs
export function writeBenchPrefs(update: Partial<BenchPrefs>, store?: StringStore): BenchPrefs
// lib/raw-stream/packet.ts
export const EXPECTED_PACKET_SIZE = 64
export interface DataPoint { /* moved verbatim */ }
export function packetTimeLabel(date: Date): string          // the MM:SS.t label, moved verbatim
export function parseDataPacket(view: DataView, ctx: { timestamp: Date; referencePower: number; synchronization: number }): DataPoint | null
// lib/raw-stream/csv.ts
export const RAW_CSV_HEADERS: readonly string[]               // the 17 existing header strings, unchanged
export function rawStreamToCsv(points: readonly DataPoint[]): string
export function rawCsvFilename(date: Date, fwVersion: string | null): string   // `cyclowatt_data_<YYYY-MM-DD>[_fw<v>].csv`
```
- [ ] **Step 1: Failing tests**: bench-prefs round trip with an in-memory `StringStore`, corrupt JSON → defaults, `setItem` throwing swallowed; packet: a synthetic 64-byte LE `DataView` (six int32 forces, accel 1500 → 1.5, gyro -250 → -0.25, power slot, tick, ticks_mcu lo/hi → BigInt/number recomposition exactly as today), wrong size → null, `packetTimeLabel(new Date(2026, 0, 1, 0, 5, 7, 300))` → whatever today's code returns (compute from the moved code, pin it); csv: header line equals `RAW_CSV_HEADERS.join(",")`, one point → 17 cells in order, filename with/without fw tag.
- [ ] **Step 2:** FAIL → **Step 3:** move code verbatim (read the page's current implementation first; keep BigInt usage and division constants exactly). **Step 4:** page imports; `exportToCSV` keeps only the Blob dance and calls `rawStreamToCsv`/`rawCsvFilename`. **Step 5:** vitest, tsc, build. **Commit** `refactor(page): move packet parsing, CSV export and bench prefs into lib`.

### Task 14: `lib/cps/measurement.ts`

**Files:** Create `lib/cps/measurement.ts`, `.test.ts`; Modify `app/page.tsx` `handleReferencePowerNotification` (~L905–915).

**Produces:** `export function parseCyclingPowerMeasurement(view: DataView): number | null` — `byteLength < 4` → null; else `getInt16(2, true)`.

- [ ] **Step 1:** failing test (short view → null; `[flags lo, flags hi, 0xfa, 0x00]` → 250; negative preserved). **Step 2:** FAIL → move. **Step 3:** page: `const w = parseCyclingPowerMeasurement(dataView); if (w === null) return; refPowerValueRef.current = w; setLatestRefPower(w)`. **Step 4:** vitest, tsc. **Commit** `refactor(cps): move the power-measurement parser into lib`.

### Task 15 (conditional — only if Tasks 1–14 are green and the clock allows): serial sync input → `hooks/use-serial-sync.ts` + `components/serial-sync-card.tsx` — **BUILD**

- [ ] Promote `lib/trainer/display-throttle.ts` to `lib/throttle.ts` (re-export from the old path to avoid churn) and use it for the 200 ms serial display throttle. Move `connectSerial`/`startSerialReading`/`disconnectSerial` (~L703–810) byte-for-byte into the hook, exposing `{ supported, connected, latestValue, valueRef, connect, disconnect }`; the page passes `valueRef` where `serialValueRef` was read on the packet path. Card JSX moved verbatim. Record in the report: not hardware-verified tonight; bench step: USB serial adapter at 9600 baud.
- [ ] tsc, vitest, build. **Commit** `refactor(page): extract the serial synchronization input into a hook and card`.

**OUT of scope tonight (record in the report):** `scanForDevices`, `connectToSpecificDevice`, `connectDfuOnly`, `handleDisconnection`, `startDataStreaming`/`stopDataStreaming`, the battery subscribe block, `syncNameFromGatt`/`recordStoredCalibration`, DfuCard wiring, the chart/zoom/range state blocks, and the reference power meter connect path (only its parser moves).
