import Link from "next/link";
import { auditActionLabel, auditSourceLabel } from "@/lib/audit-labels";
import { diffAudit } from "@/lib/audit-diff";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import type { AuditRow } from "@/server/services/audit-read";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ENTITY_HREF: Record<string, (id: string) => string> = {
  invoice: (id) => `/faktury/${id}`,
  customer: (id) => `/zakaznici/${id}`,
  recurring_invoice: (id) => `/pravidelne/${id}`,
  catalog_item: (id) => `/cenik/${id}`,
  import_batch: (id) => `/nastaveni/import/${id}`,
  dashboard: (id) => `/dashboardy/${id}/upravit`,
};

function entityHref(row: AuditRow, live: Set<string>): string | null {
  const href = row.entityId ? ENTITY_HREF[row.entity] : undefined;
  return href && live.has(`${row.entity}:${row.entityId}`) ? href(row.entityId!) : null;
}

function actorText(row: AuditRow, ownerId: string): string {
  if (row.actorId === ownerId) return TEXTS.history.self;
  return row.actorId ? TEXTS.history.other : TEXTS.history.nobody;
}

function Detail({ row }: { row: AuditRow }) {
  const changes = diffAudit(row.before, row.after);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-primary underline-offset-4 hover:underline">
        {TEXTS.history.detail}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {changes.length === 0 ? (
          <p className="text-muted-foreground">{TEXTS.history.noChanges}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{TEXTS.history.field}</TableHead>
                <TableHead>{TEXTS.history.before}</TableHead>
                <TableHead>{TEXTS.history.after}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((change) => (
                <TableRow key={change.field}>
                  <TableCell>{change.field}</TableCell>
                  <TableCell className="break-all whitespace-normal">{change.before}</TableCell>
                  <TableCell className="break-all whitespace-normal">{change.after}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground break-all">
          {[row.ip, row.userAgent, row.requestId].filter(Boolean).join(" · ")}
        </p>
      </div>
    </details>
  );
}

export function AuditTable({
  rows,
  ownerId,
  live,
}: {
  rows: AuditRow[];
  ownerId: string;
  live: Set<string>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{TEXTS.history.time}</TableHead>
          <TableHead>{TEXTS.history.event}</TableHead>
          <TableHead>{TEXTS.history.who}</TableHead>
          <TableHead>{TEXTS.history.source}</TableHead>
          <TableHead>{TEXTS.history.detail}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{formatDateTime(row.at)}</TableCell>
            <TableCell>
              {(() => {
                const href = entityHref(row, live);
                const label = auditActionLabel(row.action);
                return href ? (
                  <Link href={href} className="underline-offset-4 hover:underline">
                    {label}
                  </Link>
                ) : (
                  label
                );
              })()}
            </TableCell>
            <TableCell>{actorText(row, ownerId)}</TableCell>
            <TableCell className="break-words whitespace-normal">{auditSourceLabel(row)}</TableCell>
            <TableCell className="whitespace-normal">
              <Detail row={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
