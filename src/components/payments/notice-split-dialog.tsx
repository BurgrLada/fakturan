"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { splitNoticeAction } from "@/app/(app)/platby/actions";
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
import { MAX_SPLIT_PARTS } from "@/lib/notice-queue";
import { formatMoney, parseMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { CandidateOptions, CandidateSearch, useCandidates } from "./notice-assign-dialog";
import { NoticeSummary, type NoticeItem } from "./notice-list";

const T = TEXTS.bankQueue.split;
const A = TEXTS.bankQueue.assign;
const E = TEXTS.bankQueue.errors;

type Part = { invoiceId: string; amount: string; credited: string };
const EMPTY: Part = { invoiceId: "", amount: "", credited: "" };

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
  const [parts, setParts] = useState<Part[]>([EMPTY, EMPTY]);
  const [error, setError] = useState<string | null>(null);
  const currency = notice.currency!;
  const total = notice.amountMinor!;

  const entered = parts.reduce((sum, part) => sum + (parseMoney(part.amount) ?? 0), 0);
  const left = total - entered;
  const update = (index: number, change: Partial<Part>) =>
    setParts((current) => current.map((part, i) => (i === index ? { ...part, ...change } : part)));

  function submit(event: FormEvent) {
    event.preventDefault();
    const body: { invoiceId: string; amountMinor: number; creditedMinor: number | null }[] = [];
    for (const part of parts) {
      const amountMinor = parseMoney(part.amount);
      if (!part.invoiceId) return setError(A.choose);
      if (amountMinor === null || amountMinor <= 0) return setError(T.badAmount);
      const target = known.get(part.invoiceId);
      let creditedMinor: number | null = null;
      if (target && target.currency !== currency) {
        creditedMinor = parseMoney(part.credited);
        if (creditedMinor === null || creditedMinor <= 0) return setError(A.badCredited);
      }
      body.push({ invoiceId: part.invoiceId, amountMinor, creditedMinor });
    }
    setError(null);
    startTransition(async () => {
      try {
        const reply = await splitNoticeAction({ id: notice.id, split: { parts: body } });
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
        <AlertDialogDescription>{A.mailNote(receipts)}</AlertDialogDescription>
      </AlertDialogHeader>
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
      {parts.map((part, index) => {
        const target = known.get(part.invoiceId);
        const foreign = target !== undefined && target.currency !== currency;
        return (
          <fieldset key={index} className="flex flex-col gap-2 rounded-md border p-2">
            <legend className="px-1 text-xs text-muted-foreground">{T.part(index + 1)}</legend>
            <NativeSelect
              aria-label={`${A.invoice} ${index + 1}`}
              disabled={!candidates}
              value={part.invoiceId}
              onChange={(event) => update(index, { invoiceId: event.target.value })}
            >
              {candidates && (
                <CandidateOptions
                  candidates={
                    target && !candidates.some((row) => row.id === target.id)
                      ? [target, ...candidates]
                      : candidates
                  }
                />
              )}
            </NativeSelect>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${key}-amount-${index}`}>{`${T.amount} (${currency})`}</Label>
              <Input
                id={`${key}-amount-${index}`}
                inputMode="decimal"
                value={part.amount}
                onChange={(event) => update(index, { amount: event.target.value })}
              />
            </div>
            {foreign && target && (
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor={`${key}-credited-${index}`}
                >{`${A.credited} (${target.currency})`}</Label>
                <Input
                  id={`${key}-credited-${index}`}
                  inputMode="decimal"
                  value={part.credited}
                  onChange={(event) => update(index, { credited: event.target.value })}
                />
              </div>
            )}
            {parts.length > 2 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start max-sm:h-11"
                onClick={() => setParts((current) => current.filter((_, i) => i !== index))}
              >
                {T.removePart}
              </Button>
            )}
          </fieldset>
        );
      })}
      {parts.length < MAX_SPLIT_PARTS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start max-sm:h-11"
          onClick={() => setParts((current) => [...current, EMPTY])}
        >
          {T.addPart}
        </Button>
      )}
      <p
        data-testid="split-left"
        role="status"
        className={left === 0 ? "text-sm text-muted-foreground" : "text-sm font-medium"}
      >
        {left === 0
          ? T.done
          : left > 0
            ? T.left(formatMoney(left, currency))
            : T.over(formatMoney(-left, currency))}
      </p>
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
        <Button type="submit" className="max-sm:h-11" disabled={pending || left !== 0}>
          {T.confirm}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function NoticeSplitDialog({
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
