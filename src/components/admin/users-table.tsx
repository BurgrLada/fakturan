"use client";

import { useState, useTransition } from "react";
import {
  deactivateUserAction,
  deleteUserAction,
  reactivateUserAction,
  setRoleAction,
} from "@/app/(app)/administrace/actions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "active" | "deactivated";
  createdAt: string;
  lastLoginAt: string;
};

type Outcome = { ok: true } | { ok: false; error: string };

function DeleteUserDialog({
  row,
  pending,
  onConfirm,
}: {
  row: UserRow;
  pending: boolean;
  onConfirm: (confirmEmail: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const inputId = `confirm-${row.id}`;
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
        Smazat
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Smazat účet {row.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Smažou se všechna data účtu a nejde to vrátit. Export si musí udělat sám uživatel.
            Deaktivovaný se nepřihlásí, proto ho na export můžete dočasně reaktivovat.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={inputId}>Pro potvrzení opište e-mail</Label>
          <Input id={inputId} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Zpět</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending || typed.trim().toLowerCase() !== row.email.toLowerCase()}
            onClick={() => onConfirm(typed)}
          >
            Smazat natrvalo
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function UsersTable({ users, currentUserId }: { users: UserRow[]; currentUserId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function perform(work: () => Promise<Outcome>) {
    startTransition(async () => {
      const result = await work();
      setError(result.ok ? null : result.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Jméno</TableHead>
            <TableHead>E-mail</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Stav</TableHead>
            <TableHead>Vznik</TableHead>
            <TableHead>Poslední přihlášení</TableHead>
            <TableHead>Akce</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((row) => {
            const self = row.id === currentUserId;
            const nextRole = row.role === "admin" ? "user" : "admin";
            return (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.email}</TableCell>
                <TableCell>{row.role === "admin" ? "Administrátor" : "Uživatel"}</TableCell>
                <TableCell>
                  <Badge variant={row.status === "active" ? "secondary" : "outline"}>
                    {row.status === "active" ? "Aktivní" : "Deaktivovaný"}
                  </Badge>
                </TableCell>
                <TableCell>{row.createdAt}</TableCell>
                <TableCell>{row.lastLoginAt}</TableCell>
                <TableCell className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => perform(() => setRoleAction({ userId: row.id, role: nextRole }))}
                  >
                    {nextRole === "admin" ? "Povýšit" : "Odebrat správu"}
                  </Button>
                  {!self && row.status === "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => perform(() => deactivateUserAction({ userId: row.id }))}
                    >
                      Deaktivovat
                    </Button>
                  )}
                  {!self && row.status === "deactivated" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => perform(() => reactivateUserAction({ userId: row.id }))}
                    >
                      Reaktivovat
                    </Button>
                  )}
                  {!self && (
                    <DeleteUserDialog
                      row={row}
                      pending={pending}
                      onConfirm={(confirmEmail) =>
                        perform(() => deleteUserAction({ userId: row.id, confirmEmail }))
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
