import "server-only";
import { fitText, textLimit } from "@/lib/text-limits";
import { and, inArray, ne, or } from "drizzle-orm";
import { CURRENCIES } from "@/lib/currency";
import { foldText } from "@/lib/fold-text";
import type { ImportDocument, ImportLine, ImportParty } from "@/lib/import-document";
import { MAX_DOCUMENT_LINES } from "@/lib/invoice";
import type { CustomerAction, PreviewLink, PreviewRow, PreviewStatus } from "@/lib/import-preview";
import type { CalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { customer, invoice, supplier } from "../db/schema";
import { scoped } from "../db/scoped";
import type { Reader } from "./access";
import { customerInputSchema, type CustomerInput } from "./customers";
import { finalOf } from "./invoice-balance";

const R = TEXTS.importing.rows;
// R-12: within a unit of the currency the difference is rounding, beyond it the file is wrong.
const MAX_ROUNDING_MINOR = 100;
const MAX_LINES = MAX_DOCUMENT_LINES;
// A table has no supplier: the account's own profile stands in for it, so it is never someone else.
export const TABULAR_SOURCE = "tabular";

export type RowInput = {
  key: string;
  source: string;
  document: ImportDocument | null;
  errors: string[];
  pdfFileId: string | null;
};

// What the user decided in the preview, carried over when the rows are checked again.
export type RowDecisions = Pick<
  PreviewRow,
  "status" | "skippedFrom" | "paidOn" | "dateEstimated" | "ownConfirmed" | "customerAction"
>;

type AccountInvoice = typeof invoice.$inferSelect;
type CustomerRow = Pick<typeof customer.$inferSelect, "id" | "name" | "ico" | "archivedAt">;

const digits = (value: string) => value.replace(/\s+/g, "");

export function customerKeyOf(party: ImportParty): string {
  const ico = digits(party.ico);
  return ico ? `ico:${ico}` : `name:${foldText(party.name.trim())}`;
}

export function customerInputOf(party: ImportParty): CustomerInput {
  return {
    name: party.name.trim(),
    street: party.street,
    city: party.city,
    zip: party.zip,
    country: party.country,
    ico: party.ico,
    dic: party.dic,
    email: party.email,
    extraEmails: [],
    phone: party.phone,
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
  };
}

// A bad e-mail or IČO in a foreign file should not stop the import of the document: the new
// customer goes without the field, and the document keeps the file's data in its snapshot.
export function validCustomerInput(party: ImportParty) {
  const input = customerInputOf(party);
  const first = customerInputSchema.safeParse(input);
  if (first.success) return { ...first, dropped: false };
  for (const fallback of [{ email: "" }, { ico: "" }, { email: "", ico: "" }]) {
    const next = customerInputSchema.safeParse({ ...input, ...fallback });
    if (next.success) return { ...next, dropped: true };
  }
  return { ...first, dropped: false };
}

function paidOnFor(doc: ImportDocument, today: CalendarDate): CalendarDate {
  const due = doc.dueDate && doc.dueDate <= today ? doc.dueDate : null;
  const issue = doc.issueDate <= today ? doc.issueDate : today;
  return due ?? issue;
}

function accountDuplicates(q: Reader, ownerId: string, docs: ImportDocument[]) {
  const uuids = docs.flatMap((doc) => (doc.uuid ? [doc.uuid] : []));
  const numbers = docs.map((doc) => doc.number);
  if (docs.length === 0) return { uuids: new Set<string>(), numbers: new Set<string>() };
  const rows = q
    .select({ id: invoice.id, number: invoice.number, importUuid: invoice.importUuid })
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        or(
          uuids.length > 0 ? inArray(t.importUuid, uuids) : undefined,
          uuids.length > 0 ? inArray(t.id, uuids) : undefined,
          inArray(t.number, numbers),
        ),
      ),
    )
    .all();
  return {
    uuids: new Set(rows.flatMap((row) => [row.id, row.importUuid ?? ""])),
    numbers: new Set(rows.flatMap((row) => (row.number ? [row.number] : []))),
  };
}

function accountDocuments(
  q: Reader,
  ownerId: string,
  refs: { uuid: string | null; number: string }[],
) {
  const uuids = refs.flatMap((ref) => (ref.uuid ? [ref.uuid] : []));
  const numbers = refs.map((ref) => ref.number).filter(Boolean);
  if (uuids.length === 0 && numbers.length === 0) return [];
  return q
    .select()
    .from(invoice)
    .where(
      scoped(ownerId).where(invoice, (t) =>
        and(
          ne(t.status, "draft"),
          ne(t.status, "cancelled"),
          or(
            uuids.length > 0 ? inArray(t.importUuid, uuids) : undefined,
            uuids.length > 0 ? inArray(t.id, uuids) : undefined,
            numbers.length > 0 ? inArray(t.number, numbers) : undefined,
          ),
        ),
      ),
    )
    .all();
}

function customerAction(party: ImportParty | null, customers: CustomerRow[]): CustomerAction {
  if (!party || !party.name.trim()) return { kind: "none" };
  const ico = digits(party.ico);
  const name = party.name.trim();
  const byIco = ico ? customers.filter((row) => digits(row.ico) === ico) : [];
  const folded = foldText(name);
  const found =
    byIco.length > 0 ? byIco : customers.filter((row) => foldText(row.name.trim()) === folded);
  const [only] = found;
  if (found.length === 1 && only && only.archivedAt === null) {
    return { kind: "existing", customerId: only.id, name: only.name };
  }
  if (found.length > 0) {
    return {
      kind: "choose",
      options: found.map((row) => ({
        id: row.id,
        name: row.name,
        archived: row.archivedAt !== null,
      })),
    };
  }
  return { kind: "create", key: customerKeyOf(party), name };
}

const nameTooLong = (line: ImportLine) =>
  line.name.length > (textLimit("invoice_line", "name") ?? Number.POSITIVE_INFINITY);

// A real file may name a line at length (ruling of block A): the name keeps what fits and the
// description carries the whole of it, ahead of the line's own note.
function shortenedName(line: ImportLine): ImportLine {
  if (!nameTooLong(line)) return line;
  const whole = line.description ? `${line.name}\n${line.description}` : line.name;
  return {
    ...line,
    name: fitText("invoice_line", "name", line.name),
    description: fitText("invoice_line", "description", whole),
  };
}

type Working = PreviewRow & { document: ImportDocument };

// One pass for the preview and again right before the commit, so a document or a customer that
// changed in the meantime is judged by the account as it is now.
export function analyzeRows(
  q: Reader,
  ownerId: string,
  inputs: RowInput[],
  today: CalendarDate,
  decisions: Map<string, RowDecisions> = new Map(),
): PreviewRow[] {
  const profile = q
    .select({ ico: supplier.ico })
    .from(supplier)
    .where(scoped(ownerId).where(supplier))
    .get();
  const ownIco = digits(profile?.ico ?? "");
  const docs = inputs.flatMap((input) => (input.document ? [input.document] : []));
  const taken = accountDuplicates(q, ownerId, docs);
  const customers = q
    .select({
      id: customer.id,
      name: customer.name,
      ico: customer.ico,
      archivedAt: customer.archivedAt,
    })
    .from(customer)
    .where(scoped(ownerId).where(customer))
    .all();
  const seenUuid = new Set<string>();
  const seenNumber = new Set<string>();

  const rows: PreviewRow[] = inputs.map((input) => {
    const decided = decisions.get(input.key);
    const row: PreviewRow = {
      key: input.key,
      source: input.source,
      document: input.document,
      status: "ok",
      skippedFrom: null,
      messages: [...input.errors],
      customerAction: { kind: "none" },
      paidOn: null,
      paidMinor: 0,
      dateEstimated: false,
      ownConfirmed: null,
      original: null,
      advance: null,
      pdfFileId: input.pdfFileId,
    };
    const doc = input.document;
    let status: PreviewStatus = input.errors.length > 0 || !doc ? "error" : "ok";
    if (!doc && row.messages.length === 0) row.messages.push(R.unreadable);
    if (doc && status === "ok") {
      const problems: string[] = [];
      if (doc.type === null) problems.push(R.unsupportedType(doc.sourceType));
      if (!(CURRENCIES as readonly string[]).includes(doc.currency))
        problems.push(R.currency(doc.currency));
      if (doc.lines.length === 0) problems.push(R.noLines);
      if (doc.lines.length > MAX_LINES) problems.push(R.lines);
      // The same limits as a restore checks: what the import writes has to come back from a backup.
      const fits = (value: string | null | undefined, column: string) =>
        (value ?? "").length <= (textLimit("invoice", column) ?? Number.POSITIVE_INFINITY);
      if (
        !fits(doc.number, "number") ||
        !fits(doc.variableSymbol, "variable_symbol") ||
        !fits(doc.uuid, "import_uuid") ||
        !fits(doc.customer?.name.trim(), "customer_name")
      ) {
        problems.push(R.textTooLong);
      }
      const net = doc.lines.reduce((sum, line) => sum + line.netMinor, 0);
      if (Math.abs(doc.totalMinor - net) > MAX_ROUNDING_MINOR) problems.push(R.rounding);
      const fileIco = digits(doc.supplier.ico);
      if (fileIco && ownIco && fileIco !== ownIco) problems.push(R.otherSupplier);
      if (problems.length > 0) {
        status = "error";
        row.messages.push(...problems);
      } else {
        if (doc.lines.some(nameTooLong)) {
          row.document = { ...doc, lines: doc.lines.map(shortenedName) };
          status = "warning";
          row.messages.push(R.lineNameShortened);
        }
        if ((!fileIco || !ownIco) && doc.sourceType !== TABULAR_SOURCE) {
          row.ownConfirmed = decided?.ownConfirmed ?? false;
          if (!row.ownConfirmed) row.messages.push(R.confirmOwn);
        }
      }
      const inBatch = (doc.uuid && seenUuid.has(doc.uuid)) || seenNumber.has(doc.number);
      const inAccount = (doc.uuid && taken.uuids.has(doc.uuid)) || taken.numbers.has(doc.number);
      if (status !== "error" && (inBatch || inAccount)) {
        status = "duplicate";
        row.messages.push(
          doc.uuid && taken.uuids.has(doc.uuid)
            ? R.duplicateUuid
            : taken.numbers.has(doc.number)
              ? R.duplicateNumber
              : R.duplicateInBatch,
        );
      }
      if (status !== "error") {
        if (doc.uuid) seenUuid.add(doc.uuid);
        seenNumber.add(doc.number);
      }
    }
    row.status = status;
    return row;
  });

  const importable = (row: PreviewRow): row is Working =>
    row.document !== null &&
    (row.status === "ok" || row.status === "warning") &&
    decisions.get(row.key)?.status !== "skipped";
  const live = rows.filter(importable);
  const byRef = (type: string, ref: { uuid: string | null; number: string }) =>
    live.find(
      (row) =>
        row.document.type === type &&
        ((ref.uuid && row.document.uuid === ref.uuid) ||
          (ref.number && row.document.number === ref.number)),
    );

  const references = live.flatMap((row) => row.document.originalDocuments);
  const deposits = live.flatMap((row) =>
    row.document.deposits.map((d) => ({ uuid: null, number: d.number || d.variableSymbol })),
  );
  const accountDocs = accountDocuments(q, ownerId, [...references, ...deposits]);
  const accountRef = (type: string, ref: { uuid: string | null; number: string }) =>
    accountDocs.find(
      (row) =>
        row.type === type &&
        ((ref.uuid && (row.importUuid === ref.uuid || row.id === ref.uuid)) ||
          (ref.number && row.number === ref.number)),
    );
  const creditUse = new Map<string, number>();
  const advanceUsed = new Set<string>();

  for (const row of live) {
    const doc = row.document;
    row.customerAction = customerAction(doc.customer, customers);
    const chosen = decisions.get(row.key)?.customerAction;
    if (chosen && (chosen.kind === "existing" || chosen.kind === "create")) {
      const still = chosen.kind === "create" || customers.some((c) => c.id === chosen.customerId);
      if (still) row.customerAction = chosen;
    }
    if (row.customerAction.kind === "choose") row.messages.push(R.chooseCustomer);
    if (doc.customer && row.customerAction.kind === "create") {
      const valid = validCustomerInput(doc.customer);
      if (!valid.success) {
        row.status = "error";
        row.messages.push(R.customerInvalid(valid.error.issues[0]?.message ?? ""));
        continue;
      }
      if (valid.dropped) {
        row.status = "warning";
        row.messages.push(R.customerTrimmed);
      }
    }

    if (doc.type === "credit_note") {
      const ref = doc.originalDocuments[0];
      const inBatch = ref ? byRef("invoice", ref) : undefined;
      const inAccount = ref && !inBatch ? accountRef("invoice", ref) : undefined;
      const original: {
        key: string;
        currency: string;
        total: number;
        credits: number;
        link: PreviewLink;
      } | null = inBatch
        ? {
            key: `b:${inBatch.key}`,
            currency: inBatch.document.currency,
            total: inBatch.document.totalMinor,
            credits: 0,
            link: { kind: "batch", key: inBatch.key },
          }
        : inAccount
          ? {
              key: `a:${inAccount.id}`,
              currency: inAccount.currency,
              total: inAccount.totalMinor,
              credits: inAccount.creditsMinor,
              link: { kind: "account", id: inAccount.id },
            }
          : null;
      if (!original) {
        row.status = "error";
        row.messages.push(R.originalMissing);
        continue;
      }
      if (original.currency !== doc.currency) {
        row.status = "error";
        row.messages.push(R.originalCurrency);
        continue;
      }
      const used = (creditUse.get(original.key) ?? original.credits) + doc.totalMinor;
      if (original.total + used < 0) {
        row.status = "error";
        row.messages.push(R.originalExceeded);
        continue;
      }
      creditUse.set(original.key, used);
      row.original = original.link;
      continue;
    }

    let depositPart = 0;
    // Without a NonTaxedDeposit the amount is what was paid on the document itself, as Fakturan's
    // own export writes it (R-13 of plan 9): a payment, not an advance to look for.
    if (doc.type === "invoice" && doc.paidDepositsMinor > 0 && doc.deposits.length > 0) {
      const advance = findAdvance(q, ownerId, row, live, accountDocs, advanceUsed);
      if (advance) {
        row.advance = advance;
        depositPart = doc.paidDepositsMinor;
        // The file says the advance was paid; if the paired one is not, the final invoice would
        // carry a debt the source system no longer shows.
        const inBatch = advance.kind === "batch" && live.find((other) => other.key === advance.key);
        const paired = inBatch
          ? inBatch.document.totalMinor - inBatch.document.payableMinor
          : advance.kind === "account"
            ? (accountDocs.find((other) => other.id === advance.id)?.paidMinor ?? 0)
            : 0;
        if (paired < doc.paidDepositsMinor) {
          row.status = "warning";
          row.messages.push(R.advanceUnpaid);
        }
      } else {
        row.status = "warning";
        row.messages.push(R.advanceMissing);
      }
    }
    const paid = doc.totalMinor - doc.payableMinor - depositPart;
    if (paid > 0) {
      row.paidMinor = Math.min(paid, doc.totalMinor);
      const earlier = decisions.get(row.key);
      if (earlier?.paidOn && !earlier.dateEstimated) {
        row.paidOn = earlier.paidOn;
      } else if (doc.paidOn) {
        row.paidOn = doc.paidOn;
      } else {
        row.paidOn = paidOnFor(doc, today);
        row.dateEstimated = true;
      }
    }
  }

  for (const row of rows) {
    const decided = decisions.get(row.key);
    if (decided?.status === "skipped") {
      row.skippedFrom = row.status;
      row.status = "skipped";
    } else if (
      row.status === "ok" &&
      (row.ownConfirmed === false || row.customerAction.kind === "choose")
    ) {
      row.status = "warning";
    }
  }
  return rows;
}

function findAdvance(
  q: Reader,
  ownerId: string,
  row: Working,
  live: Working[],
  accountDocs: AccountInvoice[],
  used: Set<string>,
): PreviewLink | null {
  const doc = row.document;
  const wanted = doc.deposits.flatMap((d) => [d.number, d.variableSymbol]).filter(Boolean);
  const inBatch = live.find(
    (other) =>
      other.document.type === "advance" &&
      other.document.currency === doc.currency &&
      !used.has(`b:${other.key}`) &&
      (wanted.includes(other.document.number) ||
        (other.document.variableSymbol !== null && wanted.includes(other.document.variableSymbol))),
  );
  if (inBatch) {
    used.add(`b:${inBatch.key}`);
    return { kind: "batch", key: inBatch.key };
  }
  const sameParty = (other: AccountInvoice) => {
    if (!doc.customer) return other.customerId === null;
    const snapshot = other.customerSnapshot;
    if (!snapshot) return false;
    const ico = digits(doc.customer.ico);
    return ico
      ? digits(snapshot.ico) === ico
      : foldText(snapshot.name.trim()) === foldText(doc.customer.name.trim());
  };
  const inAccount = accountDocs.find(
    (other) =>
      other.type === "advance" &&
      other.currency === doc.currency &&
      other.supersededAt === null &&
      !used.has(`a:${other.id}`) &&
      (wanted.includes(other.number ?? "") || wanted.includes(other.variableSymbol ?? "")) &&
      sameParty(other) &&
      finalOf(q, ownerId, other.id) === null,
  );
  if (!inAccount) return null;
  used.add(`a:${inAccount.id}`);
  return { kind: "account", id: inAccount.id };
}
