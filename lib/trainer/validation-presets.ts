import type { TrainerPreset, ProtocolStep } from "./presets"

export const DEFAULT_TEST_FTP = 250

export function validTestFtp(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 2000
}

/** Rebuild only parameterized built-ins; saved custom protocols keep their watts. */
export function presetsForFtp(presets: readonly TrainerPreset[], ftp: number): TrainerPreset[] {
  const generated = validationPresets(ftp)
  const byId = new Map(generated.map(preset => [preset.id, preset]))
  return presets.map(preset => preset.builtIn ? byId.get(preset.id) ?? preset : preset)
}

/** Proposed measurement protocols, not fitness assessments. Whole-watt ERG targets. */
export function validationPresets(ftp: number): TrainerPreset[] {
  if (!validTestFtp(ftp)) throw new Error("FTP must be a whole number from 1 to 2000 W")
  const w = (fraction: number) => Math.round(ftp * fraction)
  const step = (fraction: number, rpm: number, instruction: string, seconds = 60): ProtocolStep =>
    ({ targetWatts: w(fraction), targetCadenceRpm: rpm, durationSeconds: seconds, instruction })
  const baseline = () => step(.55, 90, "Baseline — seated, steady")
  const recovery = () => step(.4, 85, "Recovery — seated, easy")
  const preset = (id: string, name: string, steps: ProtocolStep[]): TrainerPreset =>
    ({ id, name, steps, builtIn: true, savedAt: 0 })
  return [
    preset("validation-t1-core", `T1_core — load pyramid — FTP ${ftp}`, [baseline(),
      ...[.4,.55,.7,.85,.7,.55,.4].map(f => step(f,90,"Seated — hold 90 rpm")), baseline()]),
    preset("validation-t2-core", `T2_core — cadence pyramid — FTP ${ftp}`, [baseline(),
      ...[60,75,90,105,90,75,60].map(rpm => step(.55,rpm,`Seated — hold ${rpm} rpm`)), baseline()]),
    preset("validation-t12-torque", `T1_T2_extension — high torque — FTP ${ftp}`, [baseline(),
      step(.8,90,"Normal cadence — seated"), step(.8,60,"High torque — seated; keep the same gear"), recovery(),
      step(.8,60,"High torque — repeat"), step(.8,90,"Normal cadence — repeat"), baseline()]),
    preset("validation-t1-position", `T1_extension — seated versus standing — FTP ${ftp}`, [baseline(),
      step(.7,75,"SEATED — steady, no acceleration"), step(.7,75,"STANDING — steady, no sprint"), recovery(),
      step(.7,75,"STANDING — repeat"), step(.7,75,"SEATED — repeat"), baseline()]),
    {
      ...preset("validation-t5-sprint", `T5_extension — accelerations — FTP ${ftp}`, []),
      manualGuide: [
        "Use Manual → Resistance, not ERG. Choose a comfortable resistance and gear before recording; keep them fixed for matched efforts. Resistance % cannot be inferred from FTP.",
        `60 s baseline: approximately ${w(.55)} W at 90 rpm, seated.`,
        `8 s seated acceleration: rapidly build from about 75 to 110–120 rpm, aiming initially for ${w(1.5)}–${w(2)} W. This is a repeatable acceleration, not a prescribed maximum sprint.`,
        `90 s easy recovery: approximately ${w(.4)} W at 80–90 rpm.`,
        "8 s standing acceleration with the same initial gear, cadence and resistance; then 90 s easy recovery.",
        "Repeat the standing effort, recover 90 s, then repeat the seated effort and recover 90 s. Four efforts total, order seated/standing/standing/seated.",
        `60 s final baseline: approximately ${w(.55)} W at 90 rpm. Total 8 min 32 s. Use an external timer; these manual stages do not advance automatically.`,
        "Record the achieved cadence and power, position and effort times. Compare matched efforts; FTP does not determine individual sprint capacity.",
      ],
    },
    {
      ...preset("validation-t5-coast", `T5_extension — stop coast restart — FTP ${ftp}`, []),
      manualGuide: [
        `Use Manual → Resistance. Adjust resistance and gear until 90 rpm gives approximately ${w(.55)} W. Keep that setting and gear unchanged during all three repeats.`,
        `60 s seated steady pedaling: approximately ${w(.55)} W at 90 rpm.`,
        "15 s stop pedaling completely: 0 rpm, let the flywheel coast. Do not change resistance or command an ERG power step.",
        `45 s restart smoothly to 90 rpm and approximately ${w(.55)} W.`,
        "Repeat that 120 s sequence three times. Total 6 minutes. Use an external timer; these manual stages do not advance automatically.",
        "Export both logs. The current SRM cadence export becomes blank after 3 s without a crank event, so blank cadence is not evidence of a reported zero. Assess power decay and notification timing separately.",
      ],
    },
  ]
}
