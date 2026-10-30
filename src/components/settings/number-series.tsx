"use client";

import { useState, useTransition, type FormEvent } from "react";
import {
  deleteSeriesAction,
  saveSeriesAction,
  setDefaultSeriesAction,
  setNextNumberAction,
} from "@/app/(app)/nastaveni/rady/actions";
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
import {
  DOCUMENT_TYPES,
  formatNumber,
  NUMBER_PRESETS,
  previewNumber,
  RESET_PERIODS,
  validateSeriesPeriod,
  validateTemplate,
  type CalendarDate,
  type DocumentType,
  type ResetPeriod,
} from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";

export type SeriesListRow = {
  id: string;
  name: string;
  documentType: DocumentType;
  template: string;
  reset: ResetPeriod;
  isDefault: boolean;
  next: number;
  used: boolean;
};

type Values = {
  id?: string;
  name: string;
  documentType: DocumentType;
  template: string;
  reset: ResetPeriod;
};

type Outcome = { ok: true } | { ok: false; error: string };

const T = TEXTS.numberSeries;
const CUSTOM = "custom";
const EMPTY: Values = {
  name: "",
  documentType: "invoice",
  template: NUMBER_PRESETS[0]!.template,
  reset: NUMBER_PRESETS[0]!.reset,
};
// The example number from NUM-008, independent of today's date.
const PRESET_DATE = "2026-10-30";
const PRESET_N = 40;

function RemoveDialog({
  row,
  disabled,
  onConfirm,
}: {
  row: SeriesListRow;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" disabled={disabled} />}>
        {T.remove}
        <span className="sr-only"> {row.name}</span>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.removeTitle}</AlertDialogTitle>
          <AlertDialogDescription>{T.removeBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T.back}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm}>
            {T.confirmRemove}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function NumberSeries({ series, today }: { series: SeriesListRow[]; today: CalendarDate }) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [next, setNext] = useState("1");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const editing = series.find((row) => row.id === values.id);
  const presetValue =
    NUMBER_PRESETS.find((preset) => preset.template === values.template)?.template ?? CUSTOM;
  const problem =
    validateTemplate(values.template) ?? validateSeriesPeriod(values.template, values.reset);
  const previewN = Number.isSafeInteger(Number(next)) && Number(next) > 0 ? Number(next) : 1;

  function perform(work: () => Promise<Outcome>, success?: string, reset = false) {
    startTransition(async () => {
      const result = await work();
      setMessage(
        result.ok
          ? success
            ? { ok: true, text: success }
            : null
          : { ok: false, text: result.error },
      );
      if (result.ok && reset) {
        setValues(EMPTY);
        setNext("1");
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    perform(() => saveSeriesAction(values), T.saved, true);
  }

  function edit(row: SeriesListRow) {
    setMessage(null);
    setNext(String(row.next));
    setValues({
      id: row.id,
      name: row.name,
      documentType: row.documentType,
      template: row.template,
      reset: row.reset,
    });
  }

  return (
    <div className="flex flex-col gap-8">
      {message && (
        <Alert variant={message.ok ? "default" : "destructive"} role="status">
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{T.columns.name}</TableHead>
            <TableHead>{T.columns.documentType}</TableHead>
            <TableHead>{T.columns.template}</TableHead>
            <TableHead>{T.columns.reset}</TableHead>
            <TableHead>{T.columns.next}</TableHead>
            <TableHead>{T.columns.status}</TableHead>
            <TableHead>{T.columns.actions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.name}</TableCell>
              <TableCell>{T.documentTypes[row.documentType]}</TableCell>
              <TableCell className="font-mono text-xs">{row.template}</TableCell>
              <TableCell>{T.resets[row.reset]}</TableCell>
              <TableCell className="font-mono text-xs">
                {formatNumber(row.template, today, row.next)}
              </TableCell>
              <TableCell className="flex gap-1">
                {row.isDefault && <Badge>{T.default}</Badge>}
                {row.used && <Badge variant="outline">{T.used}</Badge>}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={pending} onClick={() => edit(row)}>
                    {T.edit}
                    <span className="sr-only"> {row.name}</span>
                  </Button>
                  {!row.isDefault && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => perform(() => setDefaultSeriesAction({ id: row.id }))}
                    >
                      {T.makeDefault}
                      <span className="sr-only"> {row.name}</span>
                    </Button>
                  )}
                  {!row.isDefault && !row.used && (
                    <RemoveDialog
                      row={row}
                      disabled={pending}
                      onConfirm={() => perform(() => deleteSeriesAction({ id: row.id }))}
                    />
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <form onSubmit={submit} className="flex flex-col gap-4 sm:max-w-xl">
        <h2 className="text-lg">{values.id ? T.editTitle : T.addTitle}</h2>
        <div className="flex flex-col gap-2">
          <Label htmlFor="series-name">{T.fields.name}</Label>
          <Input
            id="series-name"
            value={values.name}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="series-type">{T.fields.documentType}</Label>
          <NativeSelect
            id="series-type"
            value={values.documentType}
            disabled={!!values.id}
            onChange={(event) =>
              setValues({ ...values, documentType: event.target.value as DocumentType })
            }
          >
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {T.documentTypes[type]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="series-preset">{T.fields.preset}</Label>
          <NativeSelect
            id="series-preset"
            value={presetValue}
            disabled={editing?.used}
            onChange={(event) => {
              const preset = NUMBER_PRESETS.find((item) => item.template === event.target.value);
              if (!preset) return;
              setValues({ ...values, template: preset.template, reset: preset.reset });
            }}
          >
            {NUMBER_PRESETS.map((preset) => (
              <option key={preset.template} value={preset.template}>
                {formatNumber(preset.template, PRESET_DATE, PRESET_N)}
              </option>
            ))}
            <option value={CUSTOM}>{T.custom}</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="series-template">{T.fields.template}</Label>
          <Input
            id="series-template"
            className="font-mono"
            value={values.template}
            disabled={editing?.used}
            aria-describedby="series-tokens"
            aria-invalid={!!problem}
            onChange={(event) => setValues({ ...values, template: event.target.value })}
          />
          <p id="series-tokens" className="text-xs text-muted-foreground">
            {editing?.used ? T.usedFormatHelp : T.tokensHelp}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="series-reset">{T.fields.reset}</Label>
          <NativeSelect
            id="series-reset"
            value={values.reset}
            disabled={editing?.used}
            onChange={(event) => setValues({ ...values, reset: event.target.value as ResetPeriod })}
          >
            {RESET_PERIODS.map((reset) => (
              <option key={reset} value={reset}>
                {T.resets[reset]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <p className="text-sm" aria-live="polite">
          {problem ? (
            <span className="text-destructive">{problem}</span>
          ) : (
            <>
              {T.preview}:{" "}
              <span className="font-mono" data-testid="series-preview">
                {previewNumber(values.template, today, previewN)}
              </span>
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {T.save}
          </Button>
          {values.id && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setValues(EMPTY);
                setNext("1");
              }}
            >
              {T.cancel}
            </Button>
          )}
        </div>
      </form>
      {editing && (
        <form
          className="flex flex-col gap-2 sm:max-w-xl"
          onSubmit={(event) => {
            event.preventDefault();
            perform(() => setNextNumberAction({ id: editing.id, next: Number(next) }), T.nextSaved);
          }}
        >
          <Label htmlFor="series-next">{T.fields.next}</Label>
          <div className="flex gap-2">
            <Input
              id="series-next"
              type="number"
              min={1}
              step={1}
              value={next}
              aria-describedby="series-next-help"
              onChange={(event) => setNext(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={pending}>
              {T.saveNext}
            </Button>
          </div>
          <p id="series-next-help" className="text-xs text-muted-foreground">
            {T.nextHelp}
          </p>
        </form>
      )}
    </div>
  );
}
