import { describe, expect, test } from "vitest";
import { diffInvoices } from "@/lib/invoice-diff";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { changeDetail, changeTitle, visibleChanges } from "@/lib/version-format";

const line = {
  catalogItemId: null,
  name: "Konzultace",
  description: "",
  quantityMilli: 1000,
  unit: "hod.",
  unitPriceMinor: 100_000,
  discountKind: "none",
  discountValue: 0,
  netMinor: 100_000,
};

const doc = (over: object = {}) =>
  ({
    currency: "CZK",
    paymentMethod: "transfer",
    seriesId: "s1",
    bankAccountId: "a1",
    discountKind: "none",
    discountValue: 0,
    appearance: { colors: { accent: "#111111" } },
    snapshot: { account: { number: "123" } },
    lines: [line],
    totals: { totalMinor: 100_000, paidMinor: 0 },
    ...over,
  }) as unknown as InvoiceDocument;

function describeDiff(before: InvoiceDocument, after: InvoiceDocument) {
  const format = {
    before,
    after,
    seriesName: (id: string) => ({ s1: "Hlavní", s2: "Druhá" })[id],
  };
  return visibleChanges(diffInvoices(before, after)).map((change) =>
    `${changeTitle(change)}: ${changeDetail(change, format)}`.replace(/\s/g, " "),
  );
}

describe("popis rozdílu verzí", () => {
  test("[INV-021] částky jsou ve vlastní měně každé verze", () => {
    const out = describeDiff(
      doc({ totals: { totalMinor: 100_000, paidMinor: 0 } }),
      doc({ currency: "EUR", totals: { totalMinor: 4_000, paidMinor: 0 } }),
    );
    expect(out).toContain("Celkem: 1 000,00 Kč → 40,00 €");
  });

  test("[INV-021] místo syrových hodnot jsou popisky", () => {
    const out = describeDiff(
      doc(),
      doc({
        paymentMethod: "cash",
        seriesId: "s2",
        bankAccountId: "a2",
        appearance: { colors: { accent: "#222222" } },
        snapshot: { account: { number: "456" } },
      }),
    );
    expect(out).toEqual(
      expect.arrayContaining([
        "Způsob platby: Převodem → Hotově",
        "Číselná řada: Hlavní → Druhá",
        "Barva – Akcent: #111111 → #222222",
        "Účet – číslo: 123 → 456",
      ]),
    );
    expect(out.join()).not.toContain("a2");
  });

  test("[INV-021] u změněné položky je vidět co se změnilo", () => {
    const out = describeDiff(
      doc(),
      doc({ lines: [{ ...line, unitPriceMinor: 200_000, netMinor: 200_000 }] }),
    );
    expect(out).toContain("Změněná položka: Konzultace: cena 1 000,00 Kč → 2 000,00 Kč");
  });
});
