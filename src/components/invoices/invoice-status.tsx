import { Badge } from "@/components/ui/badge";
import type { InvoiceStatus } from "@/lib/invoice";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.statuses;

const VARIANT: Record<InvoiceStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  issued: "secondary",
  sent: "secondary",
  partially_paid: "secondary",
  paid: "default",
  cancelled: "outline",
  credited: "outline",
};

export function InvoiceStatusBadge({
  status,
  overdue,
}: {
  status: InvoiceStatus;
  overdue: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge variant={VARIANT[status]}>{T[status]}</Badge>
      {overdue && <Badge variant="destructive">{T.overdue}</Badge>}
    </span>
  );
}
