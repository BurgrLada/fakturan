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
import { isDomesticCountry } from "@/lib/customers";
import { TEXTS } from "@/lib/texts";
import type { Customer } from "@/server/services/customers";

const T = TEXTS.customers;

export function CustomerTable({ rows }: { rows: Customer[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{T.columns.name}</TableHead>
          <TableHead>{T.columns.ico}</TableHead>
          <TableHead>{T.columns.dic}</TableHead>
          <TableHead>{T.columns.email}</TableHead>
          <TableHead>{T.columns.city}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-normal">
              <Link
                href={`/zakaznici/${row.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {row.name}
              </Link>
              {!isDomesticCountry(row.country) && (
                <Badge variant="outline" className="ml-2">
                  {T.foreignBadge}
                </Badge>
              )}
              {row.archivedAt && (
                <Badge variant="secondary" className="ml-2">
                  {T.archivedBadge}
                </Badge>
              )}
            </TableCell>
            <TableCell>{row.ico || "–"}</TableCell>
            <TableCell>{row.dic || "–"}</TableCell>
            <TableCell>{row.email || "–"}</TableCell>
            <TableCell>{row.city || "–"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
