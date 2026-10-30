import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import type { CatalogItem } from "@/server/services/catalog";

const T = TEXTS.catalog;

export function CatalogTable({ rows }: { rows: CatalogItem[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{T.columns.name}</TableHead>
          <TableHead>{T.columns.category}</TableHead>
          <TableHead>{T.columns.unit}</TableHead>
          <TableHead className="text-right">{T.columns.price}</TableHead>
          <TableHead className="text-right">{T.columns.uses}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-normal">
              <Link
                href={`/cenik/${row.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {row.name}
              </Link>
              {row.archivedAt && (
                <Badge variant="secondary" className="ml-2">
                  {T.archivedBadge}
                </Badge>
              )}
            </TableCell>
            <TableCell>{row.category || "–"}</TableCell>
            <TableCell>{row.unit}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatMoney(row.priceMinor, row.currency)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.useCount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
