import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { TEXTS } from "@/lib/texts";
import { cn } from "@/lib/utils";
import type { ReportBundle } from "@/server/services/reports";
import { UnconvertedNote } from "./unconverted-note";

const T = TEXTS.reports.limits;

export function LimitsCard({ limits }: { limits: ReportBundle["limits"] }) {
  return (
    <section aria-label={T.year(limits.year)} className="space-y-3" data-testid="limits">
      <h3 className="text-sm font-medium">{T.year(limits.year)}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {limits.states.map((state) => {
          const alarm = state.watched && state.level !== "ok";
          return (
            <div
              key={state.key}
              data-testid={`limit-${state.key}`}
              className="space-y-2 rounded-md border p-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{T[state.key]}</span>
                <span
                  className={cn(
                    "text-xs",
                    alarm ? "font-medium text-destructive" : "text-muted-foreground",
                  )}
                >
                  {state.watched ? T.levels[state.level] : T.unwatched}
                </span>
              </div>
              <p className="tabular-nums">
                {state.watched
                  ? T.usage(
                      formatMoney(state.turnoverMinor, "CZK"),
                      formatMoney(state.limitMinor, "CZK"),
                      state.percent,
                    )
                  : T.turnoverOnly(formatMoney(state.turnoverMinor, "CZK"))}
              </p>
              {state.watched && (
                <div aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", alarm ? "bg-destructive" : "bg-primary")}
                    style={{ width: `${Math.min(100, state.percent)}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {limits.states[0] && <UnconvertedNote unconverted={limits.states[0].unconverted} />}
      <p className="text-sm">{T.basisLine(TEXTS.preferences.turnoverBases[limits.basis])}</p>
      <p className="text-sm text-muted-foreground">{T.note}</p>
      <Link href="/nastaveni/vychozi" className="text-sm underline underline-offset-4">
        {T.settings}
      </Link>
    </section>
  );
}
