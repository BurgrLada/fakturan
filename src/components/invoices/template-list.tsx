"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteTemplateAction, draftFromTemplateAction } from "@/app/(app)/faktury/sablony/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.invoices.templates;

export type TemplateListRow = {
  id: string;
  name: string;
  customerName: string | null;
  lineCount: number;
  updatedAt: Date;
};

export function TemplateList({ rows }: { rows: TemplateListRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function use(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        const reply = await draftFromTemplateAction({ id });
        if (reply.ok) router.push(`/faktury/${reply.id}/upravit`);
        else setError(reply.error);
      } catch {
        setError(T.failed);
      }
    });
  }

  function remove(id: string) {
    setDeleting(null);
    setError(null);
    startTransition(async () => {
      try {
        const reply = await deleteTemplateAction({ id });
        if (!reply.ok) setError(reply.error);
      } catch {
        setError(T.failed);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{T.columns.name}</TableHead>
            <TableHead>{T.columns.customer}</TableHead>
            <TableHead className="text-right">{T.columns.lines}</TableHead>
            <TableHead>{T.columns.updated}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-normal font-medium">{row.name}</TableCell>
              <TableCell className="whitespace-normal">
                {row.customerName ?? <span className="text-muted-foreground">{T.noCustomer}</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.lineCount}</TableCell>
              <TableCell>{formatDateTime(row.updatedAt)}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    disabled={pending}
                    aria-label={`${T.use}: ${row.name}`}
                    onClick={() => use(row.id)}
                  >
                    {T.use}
                  </Button>
                  <AlertDialog
                    open={deleting === row.id}
                    onOpenChange={(open) => setDeleting(open ? row.id : null)}
                  >
                    <AlertDialogTrigger
                      render={
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          aria-label={`${T.delete}: ${row.name}`}
                        />
                      }
                    >
                      {T.delete}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{T.deleteTitle}</AlertDialogTitle>
                        <AlertDialogDescription>{T.deleteBody}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{T.deleteBack}</AlertDialogCancel>
                        <Button variant="destructive" onClick={() => remove(row.id)}>
                          {T.deleteConfirm}
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
