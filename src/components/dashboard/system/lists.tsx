import Link from "next/link";
import { AUTOMATION_KEYS } from "@/lib/automation";
import { formatMoney } from "@/lib/money";
import type { DateFormat } from "@/lib/preferences";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { SystemDetail } from "@/server/reports/system-widgets";

const T = TEXTS.dashboard;
const S = T.system;

type Detail<K extends SystemDetail["kind"]> = Extract<SystemDetail, { kind: K }>;

function Footer({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm underline underline-offset-4">
      {label}
    </Link>
  );
}

export function PlanList({
  detail,
  dateFormat,
}: {
  detail: Detail<"upcoming_recurring">;
  dateFormat: DateFormat;
}) {
  return (
    <>
      <ul className="flex flex-col gap-1 text-sm" data-testid="widget-plans">
        {detail.plans.map((plan) => (
          <li key={plan.id} className="flex flex-wrap gap-x-2">
            <Link href={`/pravidelne/${plan.id}`} className="underline underline-offset-4">
              {plan.name}
            </Link>
            {plan.customerName && <span>{plan.customerName}</span>}
            <span className="text-muted-foreground">
              {S.nextIssue} {formatCalendarDate(plan.nextIssueDate, dateFormat)}
            </span>
          </li>
        ))}
      </ul>
      <Footer href="/pravidelne" label={T.actions.recurring} />
    </>
  );
}

export function NoticeList({
  detail,
  dateFormat,
}: {
  detail: Detail<"unmatched_payments">;
  dateFormat: DateFormat;
}) {
  return (
    <>
      <p className="text-sm">
        {S.pending(detail.pending)}, {S.unrecognized(detail.unrecognized)}
      </p>
      <ul className="flex flex-col gap-1 text-sm" data-testid="widget-notices">
        {detail.notices.map((row) => (
          <li key={row.id} className="flex flex-wrap gap-x-2">
            <span className="tabular-nums">
              {row.amountMinor !== null && row.currency
                ? formatMoney(row.amountMinor, row.currency)
                : "–"}
            </span>
            <span>{row.counterpartyName ?? row.variableSymbol ?? S.noticeFallback}</span>
            {row.paidOn && (
              <span className="text-muted-foreground">
                {formatCalendarDate(row.paidOn, dateFormat)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Footer href="/platby" label={T.actions.payments} />
    </>
  );
}

export function AdvancesList({
  detail,
  dateFormat,
}: {
  detail: Detail<"open_advances">;
  dateFormat: DateFormat;
}) {
  return (
    <>
      <p className="text-sm text-muted-foreground">{S.advances(detail.count)}</p>
      <ul className="flex flex-col gap-1 text-sm" data-testid="widget-advances">
        {detail.advances.map((row) => (
          <li key={row.id} className="flex flex-wrap gap-x-2">
            <Link href={`/faktury/${row.id}`} className="underline underline-offset-4">
              {row.number ?? TEXTS.reports.noName}
            </Link>
            <span>{row.customerName}</span>
            {row.dueDate && (
              <span className="text-muted-foreground">
                {TEXTS.reminders.alerts.due} {formatCalendarDate(row.dueDate, dateFormat)}
              </span>
            )}
            <span className="tabular-nums">{formatMoney(row.amountDueMinor, row.currency)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AutomationState({
  detail,
  dateFormat,
}: {
  detail: Detail<"automation_status">;
  dateFormat: DateFormat;
}) {
  const A = TEXTS.automation;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p data-testid="automation-state" className="font-medium">
        {detail.paused ? A.master.pausedState : A.master.active}
      </p>
      <ul className="flex flex-col gap-1">
        {AUTOMATION_KEYS.map((key) => (
          <li key={key} className="flex flex-wrap justify-between gap-x-2">
            <span>{A.keys[key].title}</span>
            <span className="text-muted-foreground">{detail.enabled[key] ? S.on : S.off}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">{S.sendTime(detail.sendTime)}</p>
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{S.nextRuns}</h3>
        {detail.next.length === 0 ? (
          <p className="text-muted-foreground">{S.noRuns}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.next.map((run) => (
              <li key={run.id} className="flex flex-wrap gap-x-2">
                <Link href={`/pravidelne/${run.id}`} className="underline underline-offset-4">
                  {run.name}
                </Link>
                <span className="text-muted-foreground">
                  {formatCalendarDate(run.date, dateFormat)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Footer href="/nastaveni/automatizace" label={T.actions.automation} />
    </div>
  );
}
