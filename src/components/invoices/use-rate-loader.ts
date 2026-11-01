"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadRateAction } from "@/app/(app)/faktury/actions";
import type { Currency } from "@/lib/currency";
import type { RateResult } from "@/lib/invoice-form";

const DELAY_MS = 300;

type Input = {
  enabled: boolean;
  currency: Currency;
  date: string;
  onResult: (result: RateResult) => void;
  onExpired: () => void;
};

// Asks for the rate of the decisive day whenever the question changes. A reply to an older question
// is dropped, and any failure counts as "no rate": the field stays writable (FOR-004).
export function useRateLoader({ enabled, currency, date, onResult, onExpired }: Input) {
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const apply = useRef(onResult);
  apply.current = onResult;
  const expire = useRef(onExpired);
  expire.current = onExpired;

  useEffect(() => {
    const ticket = ++latest.current;
    if (!enabled) return;
    const settle = (result: RateResult) => {
      if (ticket === latest.current) apply.current(result);
    };
    const timer = setTimeout(() => {
      loadRateAction({ currency, date }).then(
        (reply) => {
          if (!reply.ok && "expired" in reply && reply.expired) expire.current();
          settle(reply.ok ? reply.rate : null);
        },
        () => settle(null),
      );
    }, DELAY_MS);
    return () => {
      latest.current += 1;
      clearTimeout(timer);
    };
  }, [enabled, currency, date, attempt]);

  return useCallback(() => setAttempt((count) => count + 1), []);
}
