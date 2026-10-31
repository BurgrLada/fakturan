"use client";

import { useEffect, useRef, useState } from "react";
import { previewRecurringAction } from "@/app/(app)/pravidelne/actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/template-vars";
import { TEXTS } from "@/lib/texts";
import type { RecurringInput } from "@/server/services/recurring";

const T = TEXTS.recurring.preview;
const DEBOUNCE_MS = 350;

type Rows = Extract<Awaited<ReturnType<typeof previewRecurringAction>>, { ok: true }>["rows"];

export type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: Rows };

// Dates are computed on the server only; the form never repeats the recurrence rules.
export function useSchedulePreview(input: RecurringInput | null): PreviewState {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const ticket = useRef(0);
  const key = JSON.stringify(input);

  useEffect(() => {
    const current = (ticket.current += 1);
    if (key === "null") {
      setState({ kind: "idle" });
      return;
    }
    setState((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    const timer = setTimeout(async () => {
      try {
        const reply = await previewRecurringAction(JSON.parse(key));
        if (current !== ticket.current) return;
        setState(
          reply.ok ? { kind: "ready", rows: reply.rows } : { kind: "error", message: reply.error },
        );
      } catch {
        if (current === ticket.current) setState({ kind: "error", message: T.failed });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  return state;
}

export function SchedulePreview({
  state,
  blocked,
}: {
  state: PreviewState;
  blocked: string | null;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="schedule-preview-title">
      <h2 id="schedule-preview-title" className="text-lg">
        {T.title}
      </h2>
      <div data-testid="schedule-preview">
        {blocked && (
          <p role="status" className="text-sm text-muted-foreground">
            {T.blocked(blocked)}
          </p>
        )}
        {!blocked && state.kind === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        {!blocked && state.kind === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">
            {T.loading}
          </p>
        )}
        {!blocked && state.kind === "ready" && state.rows.length === 0 && (
          <p className="text-sm text-muted-foreground">{T.empty}</p>
        )}
        {!blocked && state.kind === "ready" && state.rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{T.columns.issue}</TableHead>
                <TableHead>{T.columns.period}</TableHead>
                <TableHead>{T.columns.text}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.rows.map((row) => (
                <TableRow key={row.issueDate} data-testid="preview-row">
                  <TableCell className="tabular-nums">
                    {formatCalendarDate(row.issueDate, "d. M. yyyy")}
                  </TableCell>
                  <TableCell className="whitespace-normal tabular-nums">
                    {formatCalendarDate(row.billedPeriod.from, "d. M. yyyy")}
                    {" – "}
                    {formatCalendarDate(row.billedPeriod.to, "d. M. yyyy")}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <ul className="flex flex-col gap-0.5">
                      {[
                        row.texts.textBefore,
                        ...row.texts.lines.map((line) => line.name),
                        row.texts.textAfter,
                        row.texts.note,
                      ]
                        .filter(Boolean)
                        .map((text, index) => (
                          <li key={index}>{text}</li>
                        ))}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
