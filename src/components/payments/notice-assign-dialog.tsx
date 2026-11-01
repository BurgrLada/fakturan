"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { assignNoticeAction, noticeCandidatesAction } from "@/app/(app)/platby/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
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
import { useCreditPrefill } from "@/components/invoices/use-credit-prefill";
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

const SEARCH_DELAY_MS = 250;

export function useCandidates(noticeId: string) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Kept across searches, so an already chosen document keeps its currency when it drops out of the list.
  const known = useRef(new Map<string, Candidate>());
  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () => {
        noticeCandidatesAction({ id: noticeId, search }).then(
          (reply) => {
            if (!current) return;
            if (reply.ok) {
              for (const row of reply.candidates) known.current.set(row.id, row);
              setCandidates(reply.candidates);
              setMore(reply.more);
              setError(null);
            } else setError(reply.error);
          },
          () => current && setError(E.failed),
        );
      },
      search ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [noticeId, search]);
  return { candidates, more, error, search, setSearch, known: known.current };
}

export function CandidateSearch({
  id,
  search,
  setSearch,
  more,
  shown,
}: {
  id: string;
  search: string;
  setSearch: (value: string) => void;
  more: boolean;
  shown: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{T.search}</Label>
      <Input id={id} value={search} onChange={(event) => setSearch(event.target.value)} />
      {search && shown === 0 && <p className="text-xs text-muted-foreground">{T.noMatch}</p>}
      {more && <p className="text-xs text-muted-foreground">{T.truncated(shown)}</p>}
    </div>
  );
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
  receipts,
  onClose,
  onDone,
}: {
  notice: NoticeItem;
  receipts: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const key = useId();
  const { candidates, more, error: loadError, search, setSearch, known } = useCandidates(notice.id);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const [credited, setCredited] = useState("");
  const [error, setError] = useState<string | null>(null);

  const suggested = candidates?.filter((row) => row.suggested) ?? [];
  const chosenId = selected ?? (suggested.length === 1 ? suggested[0]!.id : "");
  const chosen = known.get(chosenId) ?? null;
  const noticeCurrency = notice.currency!;
  const amountMinor = notice.amountMinor!;
  const foreign = chosen !== null && chosen.currency !== noticeCurrency;
  const { prefilled, typed } = useCreditPrefill({
    enabled: foreign,
    invoiceId: chosenId,
    currency: noticeCurrency,
    amountMinor,
    paidOn: notice.paidOn,
    onValue: setCredited,
  });
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
        <AlertDialogDescription>{T.mailNote(receipts)}</AlertDialogDescription>
      </AlertDialogHeader>
      {notice.status === "ignored" && (
        <Alert data-testid="foreign-account-warning">
          <AlertDescription>{T.foreignAccount}</AlertDescription>
        </Alert>
      )}
      {notice.provisional && (
        <p className="text-xs text-muted-foreground" data-testid="provisional-notice">
          {TEXTS.bankQueue.provisionalHint}
        </p>
      )}
      <NoticeSummary item={notice} />
      <CandidateSearch
        id={`${key}-search`}
        search={search}
        setSearch={setSearch}
        more={more}
        shown={candidates?.length ?? 0}
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${key}-invoice`}>{T.invoice}</Label>
        {candidates && candidates.length === 0 && !search ? (
          <p className="text-sm text-muted-foreground">{T.none}</p>
        ) : (
          <NativeSelect
            id={`${key}-invoice`}
            disabled={!candidates}
            value={chosen?.id ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {candidates && (
              <CandidateOptions
                candidates={
                  chosen && !candidates.some((row) => row.id === chosen.id)
                    ? [chosen, ...candidates]
                    : candidates
                }
              />
            )}
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
            onChange={(event) => {
              typed();
              setCredited(event.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">
            {prefilled
              ? T.creditedPrefilled
              : T.creditedHint(chosen.currency, formatMoney(amountMinor, noticeCurrency))}
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
  receipts,
  onClose,
  onDone,
}: {
  notice: NoticeItem | null;
  receipts: boolean;
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
        {notice && (
          <Form
            key={notice.id}
            notice={notice}
            receipts={receipts}
            onClose={onClose}
            onDone={onDone}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
