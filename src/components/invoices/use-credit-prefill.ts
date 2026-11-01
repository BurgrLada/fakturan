"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { creditPreviewAction } from "@/app/(app)/faktury/actions";
import type { Currency } from "@/lib/currency";
import { formatMoneyInput } from "@/lib/money";

const DELAY_MS = 300;

type Input = {
  enabled: boolean;
  invoiceId: string;
  currency: Currency;
  amountMinor: number | null;
  paidOn: string | null;
  onValue: (text: string) => void;
};

// Fills the amount credited to the invoice from the CNB rates of the payment day until the person
// types their own (PAY-006). A reply to an older question is dropped.
export function useCreditPrefill({
  enabled,
  invoiceId,
  currency,
  amountMinor,
  paidOn,
  onValue,
}: Input) {
  const [prefilled, setPrefilled] = useState(false);
  const typedByPerson = useRef(false);
  const latest = useRef(0);
  const apply = useRef(onValue);
  apply.current = onValue;

  useEffect(() => {
    typedByPerson.current = false;
    setPrefilled(false);
  }, [invoiceId]);

  useEffect(() => {
    if (!enabled || typedByPerson.current || amountMinor === null || !paidOn) return;
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      creditPreviewAction({ id: invoiceId, currency, amountMinor, paidOn }).then(
        (reply) => {
          if (ticket !== latest.current || typedByPerson.current) return;
          const credited = reply.ok ? reply.preview?.creditedMinor : undefined;
          setPrefilled(credited !== undefined);
          if (credited !== undefined) apply.current(formatMoneyInput(credited));
        },
        () => {},
      );
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, invoiceId, currency, amountMinor, paidOn]);

  const typed = useCallback(() => {
    typedByPerson.current = true;
    latest.current += 1;
    setPrefilled(false);
  }, []);

  return { prefilled, typed };
}
