"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  deleteBankAccountAction,
  hideBankAccountAction,
  saveBankAccountAction,
  setDefaultAccountAction,
  unhideBankAccountAction,
} from "@/app/(app)/nastaveni/ucty/actions";
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
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CURRENCIES, type Currency } from "@/lib/currency";
import { TEXTS } from "@/lib/texts";

export type AccountRow = {
  id: string;
  name: string;
  currency: Currency;
  number: string;
  bankCode: string;
  iban: string;
  swift: string;
  isDefault: boolean;
  hidden: boolean;
};

type Values = {
  id?: string;
  name: string;
  currency: Currency;
  number: string;
  bankCode: string;
  iban: string;
  swift: string;
};

type Outcome = { ok: true } | { ok: false; error: string };

const EMPTY: Values = { name: "", currency: "CZK", number: "", bankCode: "", iban: "", swift: "" };

function accountLabel(row: AccountRow): string {
  return row.number && row.bankCode ? `${row.number}/${row.bankCode}` : "";
}

function RemoveDialog({
  row,
  disabled,
  onConfirm,
}: {
  row: AccountRow;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" disabled={disabled} />}>
        {TEXTS.bankAccounts.remove}
        <span className="sr-only"> {row.name}</span>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{TEXTS.bankAccounts.removeTitle}</AlertDialogTitle>
          <AlertDialogDescription>{TEXTS.bankAccounts.removeBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{TEXTS.bankAccounts.back}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm}>
            {TEXTS.bankAccounts.confirmRemove}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BankAccounts({ accounts }: { accounts: AccountRow[] }) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const change = (name: keyof Values, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));

  function perform(work: () => Promise<Outcome>, success?: string) {
    startTransition(async () => {
      const result = await work();
      setMessage(
        result.ok
          ? success
            ? { ok: true, text: success }
            : null
          : { ok: false, text: result.error },
      );
      if (result.ok && success) setValues(EMPTY);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    perform(() => saveBankAccountAction(values), TEXTS.bankAccounts.saved);
  }

  const field = (name: Exclude<keyof Values, "id" | "currency">) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`bank-${name}`}>{TEXTS.bankAccounts.fields[name]}</Label>
      <Input
        id={`bank-${name}`}
        name={name}
        value={values[name]}
        onChange={(event) => change(name, event.target.value)}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{TEXTS.bankAccounts.empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{TEXTS.bankAccounts.columns.name}</TableHead>
              <TableHead>{TEXTS.bankAccounts.columns.currency}</TableHead>
              <TableHead>{TEXTS.bankAccounts.columns.account}</TableHead>
              <TableHead>{TEXTS.bankAccounts.columns.iban}</TableHead>
              <TableHead>{TEXTS.bankAccounts.columns.status}</TableHead>
              <TableHead>{TEXTS.bankAccounts.columns.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.currency}</TableCell>
                <TableCell>{accountLabel(row)}</TableCell>
                <TableCell className="font-mono text-xs">{row.iban}</TableCell>
                <TableCell className="flex gap-1">
                  {row.isDefault && <Badge>{TEXTS.bankAccounts.default}</Badge>}
                  {row.hidden && <Badge variant="outline">{TEXTS.bankAccounts.hidden}</Badge>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setMessage(null);
                        setValues({
                          id: row.id,
                          name: row.name,
                          currency: row.currency,
                          number: row.number,
                          bankCode: row.bankCode,
                          iban: row.iban,
                          swift: row.swift,
                        });
                      }}
                    >
                      {TEXTS.bankAccounts.edit}
                      <span className="sr-only"> {row.name}</span>
                    </Button>
                    {!row.isDefault && !row.hidden && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          perform(() =>
                            setDefaultAccountAction({ id: row.id, currency: row.currency }),
                          )
                        }
                      >
                        {TEXTS.bankAccounts.makeDefault}
                        <span className="sr-only"> {row.name}</span>
                      </Button>
                    )}
                    {!row.hidden && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => perform(() => hideBankAccountAction({ id: row.id }))}
                      >
                        {TEXTS.bankAccounts.hide}
                        <span className="sr-only"> {row.name}</span>
                      </Button>
                    )}
                    {row.hidden && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => perform(() => unhideBankAccountAction({ id: row.id }))}
                      >
                        {TEXTS.bankAccounts.unhide}
                        <span className="sr-only"> {row.name}</span>
                      </Button>
                    )}
                    <RemoveDialog
                      row={row}
                      disabled={pending}
                      onConfirm={() => perform(() => deleteBankAccountAction({ id: row.id }))}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4 sm:max-w-xl">
        <h2 className="text-lg">
          {values.id ? TEXTS.bankAccounts.editTitle : TEXTS.bankAccounts.addTitle}
        </h2>
        {field("name")}
        <div className="flex flex-col gap-2">
          <Label htmlFor="bank-currency">{TEXTS.bankAccounts.fields.currency}</Label>
          <NativeSelect
            id="bank-currency"
            value={values.currency}
            onChange={(event) => change("currency", event.target.value)}
          >
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </NativeSelect>
        </div>
        {field("number")}
        {field("bankCode")}
        {field("iban")}
        {field("swift")}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {TEXTS.bankAccounts.save}
          </Button>
          {values.id && (
            <Button type="button" variant="outline" onClick={() => setValues(EMPTY)}>
              {TEXTS.bankAccounts.cancel}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
