import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setClockForTests } from "@/server/clock";
import { auditLog, invoice, recurringInvoice, recurringRun } from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import { setAutomation } from "@/server/services/automation";
import { deleteCustomer } from "@/server/services/customers";
import { getInvoice } from "@/server/services/invoices";
import { saveTemplate } from "@/server/services/invoice-templates";
import {
  deleteRecurring,
  getRecurring,
  listRecurring,
  listRuns,
  previewRecurring,
  recurringFromTemplate,
  saveRecurring,
} from "@/server/services/recurring";
import { processOccurrence } from "@/server/services/recurring-run";
import { deleteUser, USER_OWNED_TABLES } from "@/server/services/users";
import { user } from "@/server/db/schema";
import { nextOccurrences } from "@/lib/recurrence";
import { assertConsistent } from "../helpers/consistency";
import { createTestDb } from "../helpers/db";
import { seedCustomer, seedOwner, webActor } from "../helpers/fixtures-mail";
import { planDocument, planInput, savePlan } from "../helpers/fixtures-recurring";
import { assertIsolated } from "../helpers/isolation";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-recurring-")));

const db = createTestDb();
const T0 = new Date("2026-03-10T10:00:00Z");

const owned = () => {
  const owner = seedOwner(db, T0);
  return { owner, customerId: seedCustomer(owner) };
};

const firstOccurrence = (owner: string, id: string) => {
  const plan = getRecurring(owner, id)!;
  return nextOccurrences(plan, plan.cursorDate, 1)[0]!;
};

beforeEach(() => setClockForTests({ now: () => T0 }));
afterEach(() => setClockForTests(null));

describe("uložení plánu", () => {
  test("[REC-010] výchozí režim je koncept", () => {
    const { owner, customerId } = owned();
    expect(getRecurring(owner, savePlan(owner, customerId))?.mode).toBe("draft");
  });

  test("[REC-011] režim odeslat bez zapnuté automatiky a bez potvrzení je odmítnutý", () => {
    const { owner, customerId } = owned();
    const send = { mode: "send" as const, confirmSend: true };
    expect(() => savePlan(owner, customerId, send)).toThrow(/automatiku/);
    setAutomation(webActor(owner), "recurringSend", true, { confirmed: true });
    expect(() => savePlan(owner, customerId, { mode: "send" })).toThrow(/potvrdit/);
    const id = savePlan(owner, customerId, send);
    expect(getRecurring(owner, id)?.sendConfirmedAt).toEqual(T0);
  });

  test("[REC-011] úprava potvrzeného plánu potvrzení zachová, změna režimu ho zruší", () => {
    const { owner, customerId } = owned();
    setAutomation(webActor(owner), "recurringSend", true, { confirmed: true });
    const id = savePlan(owner, customerId, { mode: "send", confirmSend: true });
    saveRecurring(webActor(owner), planInput(customerId, { id, mode: "send", name: "Nové" }));
    expect(getRecurring(owner, id)?.sendConfirmedAt).toEqual(T0);
    saveRecurring(webActor(owner), planInput(customerId, { id, mode: "issue" }));
    expect(getRecurring(owner, id)?.sendConfirmedAt).toBeNull();
    expect(() =>
      saveRecurring(webActor(owner), planInput(customerId, { id, mode: "send" })),
    ).toThrow(/potvrdit/);
  });

  test("[REC-022] neznámá proměnná je chyba při uložení", () => {
    const { owner, customerId } = owned();
    const document = planDocument({ note: "{{cena}}" });
    expect(() => savePlan(owner, customerId, { document })).toThrow(/\{\{cena\}\}/);
  });

  test("[TPL-004] proměnné čísla faktury a zákazníka jsou v plánu povolené", () => {
    const { owner, customerId } = owned();
    const document = planDocument({ note: "{{cislo_faktury}} pro {{zakaznik}}" });
    expect(savePlan(owner, customerId, { document })).toBeTruthy();
  });

  test("neplatné pravidlo jmenuje pole a cizí zákazník je odmítnutý", () => {
    const { owner, customerId } = owned();
    expect(() => savePlan(owner, customerId, { issueDay: 40 })).toThrow(/den vystavení/);
    const stranger = seedOwner(db, T0);
    expect(() => savePlan(stranger, customerId)).toThrow(ServiceError);
  });

  test("[R-18] nový plán nezačíná v minulosti, úprava kurzor nezmění", () => {
    const { owner, customerId } = owned();
    const past = savePlan(owner, customerId, { startsOn: "2025-01-01" });
    expect(getRecurring(owner, past)?.cursorDate).toBe("2026-03-09");
    const future = savePlan(owner, customerId, { startsOn: "2026-06-15" });
    expect(getRecurring(owner, future)?.cursorDate).toBe("2026-06-14");
    setClockForTests({ now: () => new Date("2026-04-20T10:00:00Z") });
    saveRecurring(webActor(owner), planInput(customerId, { id: past, startsOn: "2025-01-01" }));
    expect(getRecurring(owner, past)?.cursorDate).toBe("2026-03-09");
  });

  test("[REC-003] počet se u plánu se začátkem v minulosti počítá od prvního termínu po založení", () => {
    const { owner, customerId } = owned();
    const id = savePlan(owner, customerId, { startsOn: "2025-01-01", maxCount: 2 });
    const row = listRecurring(owner).find((plan) => plan.id === id)!;
    expect(row.nextIssueDate).toBe("2026-03-10");
    const preview = previewRecurring(
      owner,
      planInput(customerId, {
        id,
        startsOn: "2025-01-01",
        maxCount: 2,
      }),
    );
    expect(preview.map((item) => item.issueDate)).toEqual(["2026-03-10", "2026-04-10"]);
  });

  test("[REC-030] změna začátku u každých N nevytvoří druhou fakturu za stejné období", () => {
    const { owner, customerId } = owned();
    const rule = { frequency: "every_months", every: 2, startsOn: "2026-03-01" } as const;
    const id = savePlan(owner, customerId, rule);
    processOccurrence(owner, id, firstOccurrence(owner, id));
    db.update(recurringInvoice)
      .set({ cursorDate: "2026-03-10" })
      .where(eq(recurringInvoice.id, id))
      .run();
    expect(() =>
      saveRecurring(
        webActor(owner),
        planInput(customerId, { ...rule, id, startsOn: "2026-04-01" }),
      ),
    ).toThrow(/období/);
    const moved = { ...rule, id, startsOn: "2026-05-01" };
    expect(saveRecurring(webActor(owner), planInput(customerId, moved)).id).toBe(id);
    assertConsistent(db, owner);
  });

  test("[REC-004] náhled 12 termínů s vygenerovanými popisy", () => {
    const { owner, customerId } = owned();
    const preview = previewRecurring(owner, planInput(customerId, { periodOffset: -1 }));
    expect(preview).toHaveLength(12);
    expect(preview[0]).toMatchObject({
      issueDate: "2026-03-10",
      billedPeriod: { from: "2026-02-01", to: "2026-02-28" },
    });
    expect(preview[0]!.texts.textBefore).toBe("Fakturujeme únor 2026");
    expect(preview[0]!.texts.lines[0]!.name).toBe("Správa za 2/2026");
    expect(preview[11]!.issueDate).toBe("2027-02-10");
  });

  test("[TST-009] izolace plánů a běhů včetně update a remove", async () => {
    await assertIsolated<string>({
      owners: [seedOwner(db, T0), seedOwner(db, T0)],
      create: (ownerId) => savePlan(ownerId, null),
      find: (ownerId, id) => getRecurring(ownerId, id),
      list: (ownerId) => listRecurring(ownerId).map((plan) => plan.id),
      update: (ownerId, id) => {
        saveRecurring(webActor(ownerId), planInput(null, { id, name: "Změněno" }));
        return 1;
      },
      remove: (ownerId, id) => {
        deleteRecurring(webActor(ownerId), id);
        return 1;
      },
    });
    await assertIsolated<string>({
      owners: [seedOwner(db, T0), seedOwner(db, T0)],
      create: (ownerId) => {
        const id = savePlan(ownerId, null);
        return processOccurrence(ownerId, id, firstOccurrence(ownerId, id))!.runId;
      },
      find: (ownerId, runId) => {
        const row = db.select().from(recurringRun).where(eq(recurringRun.id, runId)).get();
        return row && listRuns(ownerId, row.recurringId).find((run) => run.id === runId);
      },
    });
  });

  test("[REC-014] plán ukazuje své faktury a smazání plánu fakturu nechá", () => {
    const { owner, customerId } = owned();
    const id = savePlan(owner, customerId);
    const result = processOccurrence(owner, id, firstOccurrence(owner, id))!;
    expect(getInvoice(owner, result.invoiceId!)?.recurringId).toBe(id);
    expect(listRuns(owner, id).map((run) => run.invoiceId)).toEqual([result.invoiceId]);

    deleteRecurring(webActor(owner), id);
    expect(getInvoice(owner, result.invoiceId!)?.recurringId).toBeNull();
    expect(db.select().from(recurringRun).where(eq(recurringRun.recurringId, id)).all()).toEqual(
      [],
    );
  });

  test("[AUD-002] uložení i smazání je v historii účtu", () => {
    const { owner, customerId } = owned();
    const id = savePlan(owner, customerId);
    deleteRecurring(webActor(owner), id);
    const actions = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .all()
      .map((row) => row.action);
    expect(actions).toEqual(["recurring.save", "recurring.delete"]);
  });

  test("úprava šablony nezmění plán", () => {
    const { owner, customerId } = owned();
    const template = {
      name: "Vzor",
      customerId,
      document: planDocument({ note: "původní" }),
    };
    const { id: templateId } = saveTemplate(webActor(owner), template);
    const { id } = recurringFromTemplate(webActor(owner), templateId);
    saveTemplate(webActor(owner), {
      ...template,
      id: templateId,
      document: planDocument({ note: "nová" }),
    });
    const plan = getRecurring(owner, id)!;
    expect(plan).toMatchObject({ name: "Vzor", customerId, mode: "draft" });
    expect(plan.document.note).toBe("původní");
  });

  test("smazaný zákazník nechá plán bez zákazníka a smazání účtu plán odstraní", () => {
    const { owner, customerId } = owned();
    const id = savePlan(owner, customerId);
    deleteCustomer(webActor(owner), customerId);
    expect(getRecurring(owner, id)?.customerId).toBeNull();

    expect(USER_OWNED_TABLES.indexOf(recurringRun)).toBeLessThan(
      USER_OWNED_TABLES.indexOf(invoice),
    );
    const admin = seedOwner(db, T0);
    db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).run();
    deleteUser(webActor(admin), owner, `${owner}@example.cz`);
    expect(getRecurring(owner, id)).toBeNull();
  });
});
