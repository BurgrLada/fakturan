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
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.issueDialog;

export type IssueSummary = {
  number: string | null;
  variableSymbol: string | null;
  issueDate: string | null;
  today: string;
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
            onConfirm(shown && shown !== automatic ? shown : undefined);
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{T.title}</AlertDialogTitle>
            <AlertDialogDescription>{T.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {summary?.number && <p className="text-sm font-medium">{T.number(summary.number)}</p>}
          <div className="flex flex-col gap-2">
            <Label htmlFor="issue-variable-symbol">{T.variableSymbol}</Label>
            <Input
              id="issue-variable-symbol"
              inputMode="numeric"
              maxLength={10}
              value={shown}
              onChange={(event) => setSymbol(event.target.value)}
            />
          </div>
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
