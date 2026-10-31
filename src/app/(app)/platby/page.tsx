import type { Metadata } from "next";
import { Suspense } from "react";
import { BankStatus } from "@/components/payments/bank-status";
import { NoticeList, type NoticeItem } from "@/components/payments/notice-list";
import { NoticeQueue } from "@/components/payments/notice-queue";
import { PageLoading } from "@/components/page-loading";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import {
  bankStatus,
  listNotices,
  noticeCounts,
  type NoticeRow,
} from "@/server/services/bank-notices";

export const metadata: Metadata = { title: `${TEXTS.bankQueue.title} | ${TEXTS.appName}` };

const T = TEXTS.bankQueue;
const HISTORY_LIMIT = 50;

const view = (row: NoticeRow): NoticeItem => ({ ...row, receivedAt: row.receivedAt.toISOString() });

async function PaymentsContent() {
  const { user } = await requireSession();
  const status = bankStatus(user.id);
  const counts = noticeCounts(user.id);
  const queue = listNotices(user.id, { statuses: ["pending"] }).map(view);
  const unrecognized = listNotices(user.id, { statuses: ["unrecognized"] }).map(view);
  const history = listNotices(user.id, {
    statuses: ["matched", "ignored", "dismissed"],
    limit: HISTORY_LIMIT,
  }).map(view);
  return (
    <>
      <BankStatus
        status={
          status && {
            enabled: status.enabled,
            lastCheckAt: status.lastCheckAt?.toISOString() ?? null,
            lastSuccessAt: status.lastSuccessAt?.toISOString() ?? null,
            lastNoticeAt: status.lastNoticeAt?.toISOString() ?? null,
            failureCode: status.failureCode,
            failures: status.failures,
          }
        }
      />
      <section className="flex flex-col gap-2" aria-labelledby="queue-title">
        <h2 id="queue-title" className="text-lg">
          {T.queue.title}
        </h2>
        <NoticeQueue rows={queue} total={counts.pending} />
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="unrecognized-title">
        <h2 id="unrecognized-title" className="text-lg">
          {T.unrecognized.title}
        </h2>
        {unrecognized.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.unrecognized.empty}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{T.unrecognized.body}</p>
            <NoticeList rows={unrecognized} mode="unrecognized" label={T.unrecognized.list} />
          </>
        )}
      </section>
      <section className="flex flex-col gap-2" aria-labelledby="history-title">
        <h2 id="history-title" className="text-lg">
          {T.history.title}
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.history.empty}</p>
        ) : (
          <NoticeList rows={history} mode="history" label={T.history.list} />
        )}
      </section>
    </>
  );
}

export default function PaymentsPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <PaymentsContent />
      </Suspense>
    </>
  );
}
