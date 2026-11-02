import { TEXTS } from "@/lib/texts";
import { type ChartSpec, chartTableModel } from "./chart-spec";

export function ChartTable({ spec }: { spec: ChartSpec }) {
  const model = chartTableModel(spec);
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {TEXTS.reports.chart.table}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left tabular-nums">
          <caption className="sr-only">{spec.ariaLabel}</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-1 pr-3 font-medium">
                {model.corner}
              </th>
              {model.head.map((label) => (
                <th key={label} scope="col" className="py-1 pr-3 text-right font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, index) => (
              <tr key={row.x} className="border-b last:border-0">
                <th scope="row" className="py-1 pr-3 font-normal">
                  {row.label}
                </th>
                {model.rows[index]?.cells.map((cell, column) => (
                  <td key={spec.series[column]?.key} className="py-1 pr-3 text-right">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
