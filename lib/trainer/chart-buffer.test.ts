import { describe, expect, it } from "vitest"
import { appendChartPoint, CHART_MAX_POINTS, type TrainerChartPoint } from "./chart-buffer"

const point = (t: number): TrainerChartPoint => ({ t, power: t, target: null, cadence: null })

describe("appendChartPoint", () => {
  it("pushes onto the buffer in place", () => {
    const buffer: TrainerChartPoint[] = []
    appendChartPoint(buffer, point(0))
    appendChartPoint(buffer, point(1))
    expect(buffer).toEqual([point(0), point(1)])
  })

  it("drops the oldest point once the buffer exceeds the default max (600)", () => {
    const buffer: TrainerChartPoint[] = []
    for (let i = 0; i < 600; i++) appendChartPoint(buffer, point(i))
    expect(buffer.length).toBe(600)
    expect(buffer[0]).toEqual(point(0))

    appendChartPoint(buffer, point(600)) // 601st point
    expect(buffer.length).toBe(CHART_MAX_POINTS)
    expect(buffer[0]).toEqual(point(1)) // the first point is dropped
    expect(buffer[buffer.length - 1]).toEqual(point(600))
  })

  it("honours an explicit maxPoints override", () => {
    const buffer: TrainerChartPoint[] = []
    appendChartPoint(buffer, point(0), 2)
    appendChartPoint(buffer, point(1), 2)
    appendChartPoint(buffer, point(2), 2)
    expect(buffer).toEqual([point(1), point(2)])
  })
})
