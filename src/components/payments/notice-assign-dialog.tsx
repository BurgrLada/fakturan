"use client";

import { useEffect, useId, useState, useTransition, type FormEvent } from "react";
import { assignNoticeAction, noticeCandidatesAction } from "@/app/(app)/platby/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { Currency } from "@/lib/currency";
import { formatMoney, parseMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { NoticeSummary, type NoticeItem } from "./notice-list";

const T = TEXTS.bankQueue.assign;
const E = TEXTS.bankQueue.errors;

export type Candidate = {
  id: string;
  number: string | null;
  customerName: string;
  currency: Currency;
  variableSymbol: string | null;
  dueMinor: number;
  suggested: boolean;
};

export function useCandidates(noticeId: string) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    noticeCandidatesAction({ id: noticeId }).then(
      (reply) => {
        if (!current) return;
        if (reply.ok) setCandidates(reply.candidates);
        else setError(reply.error);
      },
      () => current && setError(E.failed),
    );
    return () => {
      current = false;
    };
  }, [noticeId]);
  return { candidates, error };
}

export function candidateLabel(candidate: Candidate): string {
  return `${candidate.number ?? candidate.id} · ${candidate.customerName} · ${T.due(formatMoney(candidate.dueMinor, candidate.currency))}`;
}

export function CandidateOptions({ candidates }: { candidates: Candidate[] }) {
  const suggested = candidates.filter((row) => row.suggested);
  const others = candidates.filter((row) => !row.suggested);
  const options = (rows: Candidate[]) =>
    rows.map((row) => (
      <option key={row.id} value={row.id}>
        {candidateLabel(row)}
      </option>
    ));
  return (
    <>
      <option value="">{T.choose}</option>
      {suggested.length > 0 && <optgroup label={T.suggested}>{options(suggested)}</optgroup>}
      {others.length > 0 && <optgroup label={T.others}>{options(others)}</optgroup>}
    </>
  );
}

function Form({
  notice,
  onClose,
  onDone,
}: {
  notice: NoticeItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const key = useId();
  const { candidates, error: loadError } = useCandidates(notice.id);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const [credited, setCredited] = useState("");
  const [error, setError] = useState<string | null>(null);

  const chosen =
    candidates?.find((row) => row.id === (selected ?? candidates.find((c) => c.suggested)?.id)) ??
    null;
  const noticeCurrency = notice.currency!;
  const amountMinor = notice.amountMinor!;
  const foreign = chosen !== null && chosen.currency !== noticeCurrency;
  const overpaid =
    chosen && !foreign && amountMinor > chosen.dueMinor ? amountMinor - chosen.dueMinor : 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return setError(T.choose);
    let creditedMinor: number | null = null;
    if (foreign) {
      creditedMinor = parseMoney(credited);
      if (creditedMinor === null || creditedMinor <= 0) return setError(T.badCredited);
    }
    setError(null);
    startTransition(async () => {
      try {
        const reply = await assignNoticeAction({
          id: notice.id,
          assign: { invoiceId: chosen.id, creditedMinor },
        });
        if (reply.ok) onDone();
        else setError(reply.expired ? E.expired : reply.error);
      } catch {
        setError(E.failed);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <AlertDialogHeader>
        <AlertDialogTitle>{T.title}</AlertDialogTitle>
      </AlertDialogHeader>
      {notice.provisional && (
        <p className="text-xs text-muted-foreground" data-testid="provisional-notice">
          {TEXTS.bankQueue.provisionalHint}
        </p>
      )}
      <NoticeSummary item={notice} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${key}-invoice`}>{T.invoice}</Label>
        {candidates && candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.none}</p>
        ) : (
          <NativeSelect
            id={`${key}-invoice`}
            disabled={!candidates}
            value={chosen?.id ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {candidates && <CandidateOptions candidates={candidates} />}
          </NativeSelect>
        )}
      </div>
      {foreign && chosen && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${key}-credited`}>{`${T.credited} (${chosen.currency})`}</Label>
          <Input
            id={`${key}-credited`}
            inputMode="decimal"
            value={credited}
            onChange={(event) => setCredited(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {T.creditedHint(chosen.currency, formatMoney(amountMinor, noticeCurrency))}
          </p>
        </div>
      )}
      {overpaid > 0 && (
        <p
          data-tone="warning"
          role="status"
          className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground"
        >
          {T.overpaid(formatMoney(overpaid, noticeCurrency))}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{T.noMail}</p>
      {(error ?? loadError) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error ?? loadError}</AlertDescription>
        </Alert>
      )}
      <AlertDialogFooter>
        <Button
          type="button"
          variant="outline"
          className="max-sm:h-11"
          disabled={pending}
          onClick={onClose}
        >
          {TEXTS.bankQueue.actions.back}
        </Button>
        <Button type="submit" className="max-sm:h-11" disabled={pending || !chosen}>
          {T.confirm}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function NoticeAssignDialog({
  notice,
  onClose,
  onDone,
}: {
  notice: NoticeItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <AlertDialog
      open={notice !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        {notice && <Form key={notice.id} notice={notice} onClose={onClose} onDone={onDone} />}
      </AlertDialogContent>
    </AlertDialog>
  );
}
