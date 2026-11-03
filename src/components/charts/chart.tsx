"use client";

import {
  areaY,
  barY,
  cell,
  colorLegend,
  defineChart,
  group,
  lineY,
  stack,
  text,
} from "@tanstack/charts";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { Chart as TanChart, type ChartProps } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";

type ChartDefinition = ChartProps<unknown>["definition"];
import { ChartTable } from "./chart-table";
import {
  type ChartDatum,
  type ChartSpec,
  chartColor,
  chartData,
  formatChartValue,
} from "./chart-spec";

// Fixed so the server and the first client render produce the same SVG.
const INITIAL_WIDTH = 720;
const DEFAULT_HEIGHT = 280;
const HEAT_LEVELS = [8, 30, 55, 80, 100];

function buildDefinition(spec: ChartSpec) {
  const data = chartData(spec);
  const money = (value: number) => formatChartValue(spec.format, value);
  const labels = new Map(spec.rows.map((row) => [row.x, row.label]));
  const xLabel = (value: unknown) => labels.get(String(value)) ?? String(value);
  const color = {
    domain: spec.series.map((series) => series.label),
    range: spec.series.map((series) => chartColor(series.token)),
    ...(spec.series.length > 1 || spec.kind === "donut" ? { legend: colorLegend() } : {}),
  };
  const tip = {
    use: tooltip,
    format: (point: { datum: ChartDatum }) =>
      `${point.datum.label}\n${point.datum.series}: ${money(point.datum.value)}`,
  };
  const xTicks = { format: xLabel };
  const valueLabels = (single: boolean) =>
    spec.labels && (single ? spec.series.length === 1 : true)
      ? [
          text(data, {
            id: "value-label",
            x: "x",
            y: "value",
            text: (datum: ChartDatum) => money(datum.value),
            key: (datum: ChartDatum) => `${datum.series}|${datum.x}`,
            fill: "var(--foreground)",
            fontSize: 11,
            dy: -8,
          }),
        ]
      : [];
  const yScale = {
    scale: scaleLinear,
    grid: true,
    axis: { ticks: { format: (value: number) => money(value) } },
  };

  switch (spec.kind) {
    case "bar":
    case "stacked_bar":
      return defineChart({
        marks: [
          barY(data, {
            x: "x",
            y: "value",
            color: "series",
            layout: spec.kind === "bar" ? group() : stack(),
            radius: { end: 2 },
          }),
          ...(spec.kind === "bar" ? valueLabels(true) : []),
        ],
        scales: {
          x: { scale: () => scaleBand<string>().padding(0.2), axis: { ticks: xTicks } },
          y: yScale,
        },
        color,
        tooltip: tip,
      });
    case "line":
      return defineChart({
        marks: [
          lineY(data, { x: "x", y: "value", z: "series", color: "series", strokeWidth: 2 }),
          ...valueLabels(false),
        ],
        scales: {
          x: { scale: () => scalePoint<string>().padding(0.3), axis: { ticks: xTicks } },
          y: yScale,
        },
        color,
        tooltip: tip,
      });
    case "area":
      return defineChart({
        marks: [
          areaY(data, { x: "x", y: "value", z: "series", color: "series", fillOpacity: 0.7 }),
          ...valueLabels(false),
        ],
        scales: {
          x: { scale: () => scalePoint<string>().padding(0.3), axis: { ticks: xTicks } },
          y: yScale,
        },
        color,
        tooltip: tip,
      });
    case "donut": {
      const slices = spec.series.map((series) => ({
        x: series.key,
        label: series.label,
        series: series.label,
        value: spec.rows.reduce((sum, row) => sum + (row.values[series.key] ?? 0), 0),
      }));
      return defineChart({
        marks: [
          polar({
            inset: 8,
            radiusRatio: 0.82,
            marks: [
              radialArc(
                pie(
                  slices.map((slice) => ({ ...slice, value: Math.max(0, slice.value) })),
                  { value: "value" },
                ),
                {
                  innerRadius: ({ radius }) => radius * 0.58,
                  color: "series",
                  key: "series",
                },
              ),
            ],
            scales: { angle: null, radius: null },
          }),
        ],
        scales: { x: null, y: null },
        color,
        tooltip: tip,
      });
    }
    case "heatmap": {
      const token = spec.series[0]?.token ?? "chart-1";
      const peak = Math.max(1, ...data.map((datum) => Math.abs(datum.value)));
      const cells = data.map((datum) => ({
        ...datum,
        level:
          datum.value === 0 ? 0 : 1 + Math.min(3, Math.floor((Math.abs(datum.value) / peak) * 4)),
      }));
      return defineChart({
        marks: [
          cell(cells, {
            x: "x",
            y: "series",
            color: "level",
            key: (datum) => `${datum.series}|${datum.x}`,
            inset: 1,
          }),
        ],
        scales: {
          x: {
            scale: () =>
              scaleBand<string>()
                .domain(spec.rows.map((row) => row.x))
                .padding(0.04),
            axis: { ticks: xTicks },
          },
          y: {
            scale: () =>
              scaleBand<string>()
                .domain(spec.series.map((series) => series.label))
                .padding(0.04),
          },
        },
        color: {
          domain: HEAT_LEVELS.map((_, level) => level),
          range: HEAT_LEVELS.map(
            (share) => `color-mix(in oklab, ${chartColor(token)} ${share}%, transparent)`,
          ),
        },
        tooltip: tip,
      });
    }
  }
}

export function Chart({ spec, height = DEFAULT_HEIGHT }: { spec: ChartSpec; height?: number }) {
  const definition = useMemo(() => buildDefinition(spec) as ChartDefinition, [spec]);
  return (
    <div className="text-foreground">
      <TanChart
        definition={definition}
        ariaLabel={spec.ariaLabel}
        ariaDescription={spec.ariaDescription}
        initialWidth={INITIAL_WIDTH}
        height={height}
      />
      <ChartTable spec={spec} />
    </div>
  );
}
