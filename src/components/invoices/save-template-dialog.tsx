"use client";

import Link from "next/link";
import { useState, useTransition, type FormEvent } from "react";
import { saveInvoiceAsTemplateAction } from "@/app/(app)/faktury/sablony/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
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

const T = TEXTS.invoices.templates.save;

export function TemplatesLink() {
  return (
    <>
      {" "}
      <Link href="/faktury/sablony" className="underline underline-offset-4">
        {T.open}
      </Link>
    </>
  );
}

// React bubbles events through portals, so this must not be rendered inside another form.
export function SaveTemplateDialog({
  id,
  open,
  notice,
  onOpenChange,
  onResult,
}: {
  id: string;
  open: boolean;
  notice?: string;
  onOpenChange: (open: boolean) => void;
  onResult: (result: { ok: boolean; text: string }) => void;
}) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onOpenChange(false);
    startTransition(async () => {
      try {
        const reply = await saveInvoiceAsTemplateAction({ id, name });
        if (reply.ok) setName("");
        onResult(reply.ok ? { ok: true, text: T.saved } : { ok: false, text: reply.error });
      } catch {
        onResult({ ok: false, text: TEXTS.invoices.templates.failed });
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <form className="flex flex-col gap-4" onSubmit={save}>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.title}</AlertDialogTitle>
            <AlertDialogDescription>{T.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {notice && (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`template-name-${id}`}>{T.name}</Label>
            <Input
              id={`template-name-${id}`}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <Button type="submit" disabled={pending}>
              {T.confirm}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
