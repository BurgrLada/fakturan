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
  const filled = useRef(false);
  const apply = useRef(onValue);
  apply.current = onValue;

  useEffect(() => {
    typedByPerson.current = false;
    setPrefilled(false);
  }, [invoiceId]);

  useEffect(() => {
    if (!enabled || typedByPerson.current) return;
    if (amountMinor === null || !paidOn) {
      latest.current += 1;
      if (filled.current) {
        filled.current = false;
        setPrefilled(false);
        apply.current("");
      }
      return;
    }
    const ticket = ++latest.current;
    // A value this hook wrote must not outlive the inputs it was computed from.
    const settle = (credited: number | undefined) => {
      if (ticket !== latest.current || typedByPerson.current) return;
      setPrefilled(credited !== undefined);
      if (credited !== undefined) {
        filled.current = true;
        apply.current(formatMoneyInput(credited));
      } else if (filled.current) {
        filled.current = false;
        apply.current("");
      }
    };
    const timer = setTimeout(() => {
      creditPreviewAction({ id: invoiceId, currency, amountMinor, paidOn }).then(
        (reply) => settle(reply.ok ? reply.preview?.creditedMinor : undefined),
        () => settle(undefined),
      );
    }, DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, invoiceId, currency, amountMinor, paidOn]);

  const typed = useCallback(() => {
    typedByPerson.current = true;
    filled.current = false;
    latest.current += 1;
    setPrefilled(false);
  }, []);

  return { prefilled, typed };
}
