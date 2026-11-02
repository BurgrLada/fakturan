import "server-only";
import type { Alert } from "@/lib/automation";
import { formatMoney } from "@/lib/money";
import { LIMIT_HIGH_PERCENT, LIMIT_WARN_PERCENT, type LimitLevel } from "@/lib/turnover-limits";
import { db } from "../db";
import { limitStates } from "../reports/turnover";
import { registerDerivedAlerts } from "./notifications";

const THRESHOLD: Record<Exclude<LimitLevel, "ok">, number> = {
  warn: LIMIT_WARN_PERCENT,
  high: LIMIT_HIGH_PERCENT,
  over: 100,
};

// Only the current year is read, and the threshold is in the key, so crossing the next one is a new
// alert while a cancelled document that lowers the turnover withdraws it.
function alertsFor(ownerId: string, today: string): Alert[] {
  const year = Number(today.slice(0, 4));
  return limitStates(db, ownerId, year).flatMap((state) =>
    state.level === "ok"
      ? []
      : [
          {
            dedupeKey: `limit:${state.key}:${year}:${THRESHOLD[state.level]}`,
            kind: "turnover_limit" as const,
            params: {
              limit: state.key,
              year,
              percent: state.percent,
              turnover: formatMoney(state.turnoverMinor, "CZK"),
              limitAmount: formatMoney(state.limitMinor, "CZK"),
              over: state.level === "over",
            },
          },
        ],
  );
}

registerDerivedAlerts(alertsFor);
