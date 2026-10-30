import { Suspense } from "react";
import { auditActionLabel } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { entityHistory } from "@/server/services/audit-read";

async function History({ entity, entityId }: { entity: string; entityId: string }) {
  const { user } = await requireSession();
  const rows = await entityHistory(user.id, entity, entityId);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{TEXTS.history.emptyEntity}</p>;
  }
  return (
    <ul className="flex flex-col divide-y rounded-md border text-sm">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 p-2">
          <span>{auditActionLabel(row.action)}</span>
          <time dateTime={row.at.toISOString()} className="text-muted-foreground">
            {formatDateTime(row.at)}
          </time>
        </li>
      ))}
    </ul>
  );
}

export function EntityHistory({ entity, entityId }: { entity: string; entityId: string }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">{TEXTS.loading}</p>}>
      <History entity={entity} entityId={entityId} />
    </Suspense>
  );
}
