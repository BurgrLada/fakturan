import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-status";
import { PageLoading } from "@/components/page-loading";
import { RecurringForm } from "@/components/recurring/recurring-form";
import { MissedReview, RunList, type RunListRow } from "@/components/recurring/run-list";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import { designChoices } from "@/server/pdf/designs";
import { getCurrentSession, requireSession } from "@/server/auth/session";
import { getAutomation } from "@/server/services/automation";
import { getCustomer } from "@/server/services/customers";
import { getRecurring, listPlanInvoices, listRuns } from "@/server/services/recurring";
import { formChoices } from "../../faktury/form-data";

const T = TEXTS.recurring;

const date = (value: string | null) => (value ? formatCalendarDate(value, "d. M. yyyy") : "–");

export async function generateMetadata({
  params,
}: PageProps<"/pravidelne/[id]">): Promise<Metadata> {
  const session = await getCurrentSession();
  const plan = session && getRecurring(session.user.id, (await params).id);
  return { title: `${plan ? plan.name : T.title} | ${TEXTS.appName}` };
}

async function PlanContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireSession();
  const plan = getRecurring(user.id, id);
  if (!plan) notFound();
  const choices = formChoices(user.id, plan.document.bankAccountId);
  const customerName = plan.customerId ? (getCustomer(user.id, plan.customerId)?.name ?? "") : "";
  const runs: RunListRow[] = listRuns(user.id, id).map((run) => ({
    id: run.id,
    plannedDate: run.plannedDate,
    periodFrom: run.periodFrom,
    periodTo: run.periodTo,
    status: run.status,
    invoiceId: run.invoiceId,
    invoiceNumber: run.invoiceNumber,
    reason: run.reason,
  }));
  const invoices = listPlanInvoices(user.id, id);
  return (
    <>
      <h1 className="font-brand text-2xl">{plan.name}</h1>
      <MissedReview rows={runs.filter((run) => run.status === "missed")} />
      <RecurringForm
        planId={plan.id}
        status={plan.status}
        accounts={choices.accounts}
        units={choices.units}
        defaultUnit={choices.defaultUnit}
        recurringSend={getAutomation(user.id).recurringSend}
        designs={designChoices()}
        initial={{
          name: plan.name,
          customerId: plan.customerId,
          customerName,
          document: plan.document,
          frequency: plan.frequency,
          every: plan.every,
          issueRule: plan.issueRule,
          issueDay: plan.issueDay,
          startsOn: plan.startsOn,
          endsOn: plan.endsOn,
          maxCount: plan.maxCount,
          periodOffset: plan.periodOffset,
          mode: plan.mode,
          notifyDaysBefore: plan.notifyDaysBefore,
          sendConfirmed: plan.sendConfirmedAt !== null,
        }}
      />
      <section className="flex flex-col gap-3" aria-labelledby="plan-invoices-title">
        <h2 id="plan-invoices-title" className="text-lg">
          {T.detail.invoices}
        </h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.detail.noInvoices}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{TEXTS.invoices.detail.title}</TableHead>
                <TableHead>{T.detail.runColumns.period}</TableHead>
                <TableHead>{T.detail.runColumns.status}</TableHead>
                <TableHead className="text-right">{TEXTS.invoices.detail.total}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((row) => (
                <TableRow key={row.id} data-testid="plan-invoice">
                  <TableCell>
                    {/* Plain anchor, see run-list.tsx. */}
                    <a href={`/faktury/${row.id}`} className="underline underline-offset-4">
                      {row.number ?? T.detail.openDraft}
                    </a>
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {date(row.periodFrom)} – {date(row.periodTo)}
                  </TableCell>
                  <TableCell>
                    <InvoiceStatusBadge status={row.status} overdue={false} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.totalMinor, row.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="flex flex-col gap-3" aria-labelledby="plan-runs-title">
        <h2 id="plan-runs-title" className="text-lg">
          {T.detail.runs}
        </h2>
        <RunList rows={runs} />
      </section>
    </>
  );
}

export default function RecurringDetailPage({ params }: PageProps<"/pravidelne/[id]">) {
  return (
    <>
      <Link
        href="/pravidelne"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {T.back}
      </Link>
      <Suspense fallback={<PageLoading />}>
        <PlanContent params={params} />
      </Suspense>
    </>
  );
}
