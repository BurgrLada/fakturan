import { formatMoney } from "@/lib/money";
import type { Cell, Sheet } from "@/lib/tabular";
import { TEXTS } from "@/lib/texts";

const NUMBER = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 });

function shown(cell: Cell): string {
  if (cell === null) return "";
  switch (cell.kind) {
    case "text":
      return cell.value;
    case "money":
      return formatMoney(cell.minor, cell.currency);
    case "number":
      return NUMBER.format(cell.value);
    case "date": {
      const [year, month, day] = cell.value.split("-").map(Number);
      return `${day}. ${month}. ${year}`;
    }
  }
}

// The same sheet the export writes, so the page and the file can never disagree.
export function ReportTable({ sheet }: { sheet: Sheet }) {
  if (sheet.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{TEXTS.reports.emptyTable}</p>;
  }
  return (
    <div className="w-full max-w-full overflow-x-auto rounded-md border" data-testid="report-table">
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">{sheet.name}</caption>
        <thead>
          <tr className="border-b bg-muted/50">
            {sheet.columns.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={`px-3 py-2 font-medium whitespace-nowrap ${index > 0 ? "text-right" : ""}`}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-0">
              {row.map((cell, index) =>
                index === 0 ? (
                  <th key={index} scope="row" className="px-3 py-1.5 font-normal">
                    {shown(cell)}
                  </th>
                ) : (
                  <td
                    key={index}
                    className={`px-3 py-1.5 text-right whitespace-nowrap ${cell?.kind === "money" && cell.minor < 0 ? "text-destructive" : ""}`}
                  >
                    {shown(cell)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
