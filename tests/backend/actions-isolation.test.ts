import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  deleteBankAccountAction,
  hideBankAccountAction,
  saveBankAccountAction,
  setDefaultAccountAction,
  unhideBankAccountAction,
} from "@/app/(app)/nastaveni/ucty/actions";
import {
  deleteSeriesAction,
  saveSeriesAction,
  setDefaultSeriesAction,
  setNextNumberAction,
} from "@/app/(app)/nastaveni/rady/actions";
import { savePreferencesAction } from "@/app/(app)/nastaveni/vychozi/actions";
import {
  deleteTemplateAction,
  draftFromTemplateAction,
  saveInvoiceAsTemplateAction,
} from "@/app/(app)/faktury/sablony/actions";
import { user } from "@/server/db/schema";
import { listBankAccounts, saveBankAccount } from "@/server/services/bank-accounts";
import { getTemplate, listTemplates, saveTemplate } from "@/server/services/invoice-templates";
import { listInvoices, newDraftDefaults, saveDraft } from "@/server/services/invoices";
import { listSeries, saveSeries } from "@/server/services/number-series";
import { getPreferences } from "@/server/services/preferences";
import { createTestDb } from "../helpers/db";

const session = vi.hoisted(() => ({ userId: "a1" }));

vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ user: { id: session.userId } }),
  actorFromRequest: async () => ({ userId: session.userId, source: "web" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-actions-")));

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });

function seed(id: string) {
  const now = new Date();
  db.insert(user)
    .values({ id, name: id, email: `${id}@example.cz`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

const account = {
  name: "Provozní",
  currency: "CZK" as const,
  number: "1234567890",
  bankCode: "2010",
  iban: "",
  swift: "",
};

describe("cizí id přes server actions", () => {
  test("[TST-009] cizí šablonu ani fakturu nejde použít ani smazat přes server action", async () => {
    seed("t1");
    seed("t2");
    const { id: templateId } = saveTemplate(actor("t1"), {
      name: "Moje šablona",
      customerId: null,
      document: {
        ...newDraftDefaults("t1", null),
        type: "invoice",
        dueDays: 14,
        lines: [],
      },
    });
    const { id: invoiceId } = saveDraft(actor("t1"), {
      ...newDraftDefaults("t1", null),
      note: "Soukromá poznámka",
    });
    session.userId = "t2";

    const replies = [
      await draftFromTemplateAction({ id: templateId }),
      await deleteTemplateAction({ id: templateId }),
      await saveInvoiceAsTemplateAction({ id: invoiceId, name: "Kopie cizí faktury" }),
    ];

    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
    expect(listInvoices("t2", {}).rows).toEqual([]);
    expect(listTemplates("t2")).toEqual([]);
    expect(getTemplate("t1", templateId)?.name).toBe("Moje šablona");
  });

  test("[TST-009] vlastní šablona přes server action projde", async () => {
    seed("t3");
    session.userId = "t3";
    const { id: invoiceId } = saveDraft(actor("t3"), newDraftDefaults("t3", null));

    const saved = await saveInvoiceAsTemplateAction({ id: invoiceId, name: "Vlastní" });
    if (!saved.ok) throw new Error(saved.error);
    const draft = await draftFromTemplateAction({ id: saved.id });
    const removed = await deleteTemplateAction({ id: saved.id });

    expect(draft).toMatchObject({ ok: true });
    expect(removed).toMatchObject({ ok: true });
  });

  test("[SEC-002] cizí bankovní účet nejde změnit, skrýt, nastavit ani smazat přes server action", async () => {
    seed("a1");
    seed("a2");
    const mine = saveBankAccount(actor("a1"), account);
    session.userId = "a2";

    const results = [
      await saveBankAccountAction({ ...account, id: mine, name: "Přepsáno" }),
      await setDefaultAccountAction({ id: mine, currency: "CZK" }),
      await hideBankAccountAction({ id: mine }),
      await unhideBankAccountAction({ id: mine }),
      await deleteBankAccountAction({ id: mine }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false });
    expect(listBankAccounts("a1")).toMatchObject([{ id: mine, name: "Provozní", hidden: false }]);
    expect(listBankAccounts("a2")).toEqual([]);
  });

  test("[SEC-002] cizí číselná řada nejde změnit, nastavit ani smazat přes server action", async () => {
    seed("b1");
    seed("b2");
    const mine = saveSeries(actor("b1"), {
      name: "Exporty",
      documentType: "invoice",
      template: "EX{RR}-{NN}",
      reset: "yearly",
    });
    session.userId = "b2";

    const results = [
      await saveSeriesAction({
        id: mine,
        name: "Přepsáno",
        documentType: "invoice",
        template: "EX{RR}-{NN}",
        reset: "yearly",
      }),
      await setNextNumberAction({ id: mine, next: 40, date: "2026-10-30" }),
      await setDefaultSeriesAction({ id: mine }),
      await deleteSeriesAction({ id: mine }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false });
    const rows = listSeries("b1", "2026-10-30");
    expect(rows.find((row) => row.id === mine)).toMatchObject({ name: "Exporty", next: 1 });
    expect(listSeries("b2", "2026-10-30").map((row) => row.id)).not.toContain(mine);
  });

  test("[SEC-002] výchozí hodnoty se ukládají jen přihlášenému uživateli, i když vstup nese cizí id", async () => {
    seed("c1");
    seed("c2");
    session.userId = "c2";

    const result = await savePreferencesAction({ dueDays: 30, userId: "c1" });

    expect(result).toMatchObject({ ok: true });
    expect(getPreferences("c2").dueDays).toBe(30);
    expect(getPreferences("c1").dueDays).toBe(14);
  });
});
