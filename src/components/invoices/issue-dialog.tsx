"use client";

import { useState } from "react";
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
import type { Currency } from "@/lib/currency";
import type { InvoiceType } from "@/lib/invoice";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.issueDialog;

export type IssueSummary = {
  number: string | null;
  variableSymbol: string | null;
  issueDate: string | null;
  today: string;
  customerName: string;
  totalMinor: number;
  currency: Currency;
  discountNotes: string[];
  type: InvoiceType;
};

export function IssueDialog({
  summary,
  pending,
  error,
  onCancel,
  onToday,
  onConfirm,
}: {
  summary: IssueSummary | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onToday: () => void;
  onConfirm: (variableSymbol: string | undefined) => void;
}) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const automatic = summary?.variableSymbol ?? "";
  const shown = symbol ?? automatic;
  const cancel = () => {
    if (pending) return;
    setSymbol(null);
    onCancel();
  };
  const isNote = summary?.type === "credit_note";
  const wrongMonth = summary?.issueDate?.slice(0, 7) !== summary?.today.slice(0, 7);

  return (
    <AlertDialog
      open={summary !== null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(shown !== automatic ? shown : undefined);
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{isNote ? T.creditTitle : T.title}</AlertDialogTitle>
            <AlertDialogDescription>{isNote ? T.creditBody : T.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {summary?.number && <p className="text-sm font-medium">{T.number(summary.number)}</p>}
          {summary && (
            <div className="text-sm">
              <p>{T.customer(summary.customerName)}</p>
              <p>{T.total(formatMoney(summary.totalMinor, summary.currency))}</p>
            </div>
          )}
          {summary?.discountNotes.map((note) => (
            <Alert key={note}>
              <AlertDescription>{note}</AlertDescription>
            </Alert>
          ))}
          {!isNote && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="issue-variable-symbol">{T.variableSymbol}</Label>
              <Input
                id="issue-variable-symbol"
                inputMode="numeric"
                maxLength={10}
                value={shown}
                onChange={(event) => setSymbol(event.target.value)}
              />
              {!shown && automatic && <p className="text-sm text-muted-foreground">{T.noSymbol}</p>}
            </div>
          )}
          {wrongMonth && (
            <Alert>
              <AlertDescription className="flex flex-col items-start gap-2">
                {T.wrongMonth}
                <Button type="button" variant="outline" disabled={pending} onClick={onToday}>
                  {T.today}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={cancel}>
              {T.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {T.confirm}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
