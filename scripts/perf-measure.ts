// node scripts/perf-measure.ts [--documents 30000]
// Seeds a throwaway SQLite with one account of the given size (two payments per document, audit
// rows like real use) and prints statements and times of the hot paths and the size of the cached
// entries. Documents are cloned in SQL from one issued through the services, which takes seconds.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function withExtension(path: string): string {
  if (existsSync(`${path}.ts`)) return `${path}.ts`;
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "index.ts") : path;
}

// Node strips the types but knows neither the @/ alias nor imports without an extension, and the
// PDF designs are JSX, which none of the measured paths renders.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return {
        url: pathToFileURL(join(root, "tests/helpers/server-only.ts")).href,
        shortCircuit: true,
      };
    }
    if (
      /(?<!mail\/html)\/(pdf\/)?(designs|render)$/.test(specifier) &&
      !specifier.startsWith("/")
    ) {
      return {
        url: pathToFileURL(join(root, "tests/helpers/designs-stub.ts")).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/")) {
      return {
        url: pathToFileURL(withExtension(join(root, "src", specifier.slice(2)))).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/")) {
      const parent = dirname(fileURLToPath(context.parentURL));
      return {
        url: pathToFileURL(withExtension(join(parent, specifier))).href,
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isInteger(value) || value < 1) {
    console.error(`Použití: node scripts/perf-measure.ts [--${name} <počet>]`);
    process.exit(2);
  }
  return value;
}

const documents = argument("documents", 30_000);
const customers = 200;
const dir = mkdtempSync(join(tmpdir(), "fakturan-perf-"));
// The database grows to hundreds of MB: it goes on any exit, a failed or interrupted run included.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(130));
process.env.DATA_DIR = dir;
process.env.DATABASE_PATH = join(dir, "perf.db");
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "perf-measure-secret-perf-measure-secret";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { createDb, runMigrations, setDbForTests } = await import("@/server/db");
const { user } = await import("@/server/db/schema");
const { calendarDateInPrague } = await import("@/lib/number-format");
const { clock } = await import("@/server/clock");
const { ensureDefaultSeries } = await import("@/server/services/number-series");
const { saveSupplier } = await import("@/server/services/supplier");
const { saveBankAccount } = await import("@/server/services/bank-accounts");
const { saveCustomer } = await import("@/server/services/customers");
const { newDraftDefaults, saveDraft, getInvoice, listInvoices } =
  await import("@/server/services/invoices");
const { issueInvoice } = await import("@/server/services/invoice-lifecycle");
const { addPayment } = await import("@/server/services/payments");
await import("@/server/services/due-alerts");
await import("@/server/services/limit-alerts");
await import("@/server/services/payment-alerts");
const { bellState } = await import("@/server/services/notifications");
const { accountStamp, reportSummary } = await import("@/server/services/reports");
const { reportBundle } = await import("@/server/reports/bundle");
const { forecast } = await import("@/server/reports/forecast");
const { taxOverview, taxPage } = await import("@/server/reports/tax");
const { widgetResult, checkedConfig } = await import("@/server/services/widgets");
const { parseReportFilter, reportQuery, filterFromQuery } = await import("@/lib/report-filter");
const { WIDGET_GALLERY } = await import("@/lib/dashboard-defaults");

const db = createDb(process.env.DATABASE_PATH);
runMigrations(db);
setDbForTests(db);
const sqlite = db.$client;

const owner = "perf-owner";
const actor = { userId: owner, source: "web" as const };
const today = calendarDateInPrague(clock.now());

function seedAccount(): void {
  const now = clock.now();
  db.insert(user)
    .values({ id: owner, name: "Výkon", email: "perf@example.cz", createdAt: now, updatedAt: now })
    .run();
  ensureDefaultSeries(actor);
  saveSupplier(actor, {
    name: "Jan Novák",
    street: "Dlouhá 1",
    city: "Praha",
    zip: "110 00",
    country: "Česká republika",
    ico: "27082440",
    dic: "",
    email: "",
    phone: "",
    web: "",
    registryNote: "",
    contactPerson: "",
    vatIdentified: false,
    footerText: "",
    notVatPayerCs: "Nejsem plátce DPH.",
    notVatPayerEn: "I am not a VAT payer.",
  });
  saveBankAccount(actor, {
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });
  for (let i = 0; i < customers; i += 1) {
    saveCustomer(actor, {
      name: `Zákazník ${String(i).padStart(3, "0")} s.r.o.`,
      street: "Krátká 2",
      city: "Brno",
      zip: "602 00",
      country: "Česká republika",
      ico: "",
      dic: "",
      email: `z${i}@example.cz`,
      extraEmails: [],
      phone: "",
      note: "",
      dueDays: null,
      language: null,
      currency: null,
      designId: null,
      remindersEnabled: null,
    });
  }
}

function templateInvoice(): string {
  const customerId = (sqlite.prepare("SELECT id FROM customer LIMIT 1").get() as { id: string }).id;
  const line = (name: string, unitPriceMinor: number) => ({
    catalogItemId: null,
    name,
    description: "",
    quantityMilli: 1000,
    unit: "ks",
    unitPriceMinor,
    discountKind: "none" as const,
    discountValue: 0,
  });
  const { id, revision } = saveDraft(actor, {
    ...newDraftDefaults(owner, customerId),
    lines: [line("Konzultace", 150_000), line("Správa webu", 50_000)],
  });
  issueInvoice(actor, id, { revision });
  addPayment(actor, id, {
    revision: getInvoice(owner, id)!.revision,
    paidOn: today,
    amountMinor: 100_000,
    currency: "CZK",
    method: "transfer",
    note: "",
  });
  return id;
}

function columns(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

// Copies the template rows `count` times; `overrides` are SQL over the template `t` and the counter `i`.
function clone(
  table: string,
  where: string,
  count: number,
  overrides: Record<string, string>,
  ...params: unknown[]
): void {
  const names = columns(table);
  const list = names.map((name) => overrides[name] ?? `t."${name}"`).join(", ");
  sqlite
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
       INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
       SELECT ${list} FROM n, "${table}" t WHERE ${where}`,
    )
    .run(...params);
}

function cloneAccount(template: string): void {
  sqlite.exec(`CREATE TEMP TABLE perf_customer (rn INTEGER PRIMARY KEY, id TEXT, name TEXT);
    INSERT INTO perf_customer (rn, id, name)
      SELECT row_number() OVER (ORDER BY id) - 1, id, name FROM customer;`);
  const issue = `date('${today}', '-' || (i % 1095) || ' days')`;
  const status = `CASE WHEN i % 20 = 0 THEN 'draft' WHEN i % 20 = 1 THEN 'cancelled'
    WHEN i % 3 = 0 THEN 'sent' ELSE 'paid' END`;
  const total = `(10000 + (i * 7919) % 500000)`;
  const customer = `(SELECT id FROM perf_customer WHERE rn = i % ${customers})`;
  const customerName = `(SELECT name FROM perf_customer WHERE rn = i % ${customers})`;
  const euro = `i % 10 = 5`;
  clone(
    "invoice",
    "t.id = ?",
    documents,
    {
      id: `printf('perf-inv-%06d', i)`,
      number: `CASE WHEN i % 20 = 0 THEN NULL ELSE printf('P%06d', i) END`,
      variable_symbol: `printf('%06d', i)`,
      status,
      issue_date: issue,
      taxable_date: issue,
      due_date: `date(${issue}, '+14 days')`,
      customer_id: customer,
      customer_name: customerName,
      currency: `CASE WHEN ${euro} THEN 'EUR' ELSE 'CZK' END`,
      exchange_rate_micros: `CASE WHEN ${euro} THEN 25000000 ELSE t.exchange_rate_micros END`,
      subtotal_minor: total,
      total_minor: total,
      paid_minor: `CASE WHEN i % 20 > 1 AND i % 3 <> 0 THEN ${total} ELSE 0 END`,
      search_text: `'p' || printf('%06d', i) || char(10) || fold_text(${customerName})`,
      issued_at: `CASE WHEN i % 20 = 0 THEN NULL ELSE t.issued_at END`,
      import_uuid: "NULL",
    },
    template,
  );
  clone(
    "invoice_line",
    "t.invoice_id = ?",
    documents,
    {
      id: `printf('perf-line-%06d-%d', i, t.position)`,
      invoice_id: `printf('perf-inv-%06d', i)`,
    },
    template,
  );
  clone(
    "payment",
    "t.invoice_id = ?",
    documents * 2,
    {
      id: `printf('perf-pay-%06d', i)`,
      invoice_id: `printf('perf-inv-%06d', (i + 1) / 2)`,
      paid_on: `date('${today}', '-' || (((i + 1) / 2) % 1095) || ' days', '+10 days')`,
      amount_minor: `(10000 + (((i + 1) / 2) * 7919) % 500000) / 2`,
    },
    template,
  );
  sqlite
    .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO audit_log (at, actor_id, owner_id, source, scope, action, entity, entity_id)
    SELECT 1700000000000 + i * 1000, ?, ?, 'web', 'user', 'invoice.update', 'invoice',
           printf('perf-inv-%06d', i / 5)
    FROM n`)
    .run(documents * 5, owner, owner);
  for (let month = 0; month < 36; month += 1) {
    const listDate = sqlite
      .prepare(`SELECT date(?, '-' || ? || ' months') AS d`)
      .get(today, month) as {
      d: string;
    };
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO exchange_rate (currency, list_date, rate_micros, fetched_at) VALUES ('EUR', ?, ?, ?)",
      )
      .run(listDate.d, 24_000_000 + month * 10_000, Date.parse(`${listDate.d}T13:00:00Z`));
  }
}

type Row = { step: string; statements: number; first: number; median: number; note: string };

function recorded<T>(run: () => T): { result: T; statements: number; ms: number } {
  const original = sqlite.prepare;
  let statements = 0;
  sqlite.prepare = ((source: string) => {
    statements += 1;
    return original.call(sqlite, source);
  }) as typeof sqlite.prepare;
  const started = performance.now();
  try {
    const result = run();
    return { result, statements, ms: performance.now() - started };
  } finally {
    sqlite.prepare = original;
  }
}

function measure<T>(step: string, run: () => T, note: (result: T) => string = () => ""): Row {
  const first = recorded(run);
  const times = Array.from({ length: 4 }, () => recorded(run).ms).sort((a, b) => a - b);
  return {
    step,
    statements: first.statements,
    first: first.ms,
    median: (times[1]! + times[2]!) / 2,
    note: note(first.result),
  };
}

const kib = (value: unknown) =>
  `${(Buffer.byteLength(JSON.stringify(value)) / 1024).toFixed(1)} KiB`;

const seedStarted = performance.now();
seedAccount();
cloneAccount(templateInvoice());
const seedMs = performance.now() - seedStarted;

const parsed = parseReportFilter({}, today);
const yearFilter = filterFromQuery(reportQuery(parsed));
const allTime = { ...yearFilter, range: { from: "2000-01-01", to: today } };
const summaryFilter = { range: yearFilter.range, includeExternal: true };
const year = Number(today.slice(0, 4));

const rows: Row[] = [
  measure(
    "zvonek (bellState)",
    () => bellState(owner),
    (r) => `unread ${r.unread}, alerts ${r.alerts}`,
  ),
  measure(
    "forecast",
    () => forecast(db, owner, today),
    (r) => `${r.length} měsíců`,
  ),
  measure(
    "accountStamp",
    () => accountStamp(owner),
    (r) => r,
  ),
  measure("reportSummary (letos)", () => reportSummary(owner, summaryFilter, today)),
  measure("reportSummary (vše)", () =>
    reportSummary(owner, { range: allTime.range, includeExternal: true }, today),
  ),
  measure(
    "listInvoices (výchozí)",
    () => listInvoices(owner, {}),
    (r) => `${r.rows.length} řádků`,
  ),
  measure("listInvoices (zákazník ↓)", () =>
    listInvoices(owner, { sort: "customer", dir: "desc" }),
  ),
  measure("listInvoices (hledání)", () => listInvoices(owner, { q: "zákazník 042" })),
  measure("listInvoices (po splatnosti)", () => listInvoices(owner, { status: "overdue" })),
  measure("reportBundle (letos)", () => reportBundle(db, owner, yearFilter, today), kib),
  measure("reportBundle (vše)", () => reportBundle(db, owner, allTime, today), kib),
  measure("taxPage", () => taxPage(taxOverview(db, owner, { year, basis: "paid" }, today)), kib),
];

let widgetBytes = 0;
let widgetMs = 0;
let widgetStatements = 0;
for (const item of WIDGET_GALLERY) {
  const run = recorded(() =>
    widgetResult(owner, checkedConfig(item.config), { today, globalFilter: {} }),
  );
  widgetBytes += Buffer.byteLength(JSON.stringify(run.result));
  widgetMs = Math.max(widgetMs, run.ms);
  widgetStatements += run.statements;
}
rows.push({
  step: `widgety galerie (${WIDGET_GALLERY.length})`,
  statements: widgetStatements,
  first: widgetMs,
  median: widgetMs,
  note: `celkem ${(widgetBytes / 1024).toFixed(1)} KiB, čas = nejpomalejší widget`,
});

const counts = sqlite
  .prepare(
    `SELECT (SELECT count(*) FROM invoice) AS invoices, (SELECT count(*) FROM payment) AS payments,
            (SELECT count(*) FROM audit_log) AS audit`,
  )
  .get() as { invoices: number; payments: number; audit: number };
console.log(
  `Dokladů ${counts.invoices}, plateb ${counts.payments}, auditu ${counts.audit}; seed ${(seedMs / 1000).toFixed(1)} s; dnes ${today}`,
);
console.log("| Krok | Dotazů | První (ms) | Medián (ms) | Poznámka |");
console.log("|---|---:|---:|---:|---|");
for (const row of rows) {
  console.log(
    `| ${row.step} | ${row.statements} | ${row.first.toFixed(1)} | ${row.median.toFixed(1)} | ${row.note} |`,
  );
}

sqlite.close();
