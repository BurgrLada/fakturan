import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { contrastRatio, MIN_TEXT_CONTRAST } from "@/lib/contrast";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { setClockForTests } from "@/server/clock";
import { user } from "@/server/db/schema";
import { DESIGNS } from "@/server/pdf/designs";
import { renderInvoicePdf } from "@/server/pdf/render";
import { buildInvoiceView } from "@/server/pdf/view";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { samplePreviewDocument } from "@/server/services/design-preview";
import { issueInvoice } from "@/server/services/invoice-lifecycle";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import { newDraftDefaults, saveDraft } from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { getPreferences, savePreferences } from "@/server/services/preferences";
import { saveSupplier, setSupplierImage } from "@/server/services/supplier";
import { saveCustomer } from "@/server/services/customers";
import {
  FIXTURE_LOGO_ID,
  FIXTURE_LOGO_SVG,
  INVOICE_FIXTURES,
  fixtureLine,
} from "../fixtures/invoices";
import { createTestDb } from "../helpers/db";
import { decodeQr, expectMatchesSnapshot, pdfPagePng, pdfText, pdfTextItems } from "../helpers/pdf";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-designs-")));

const session = vi.hoisted(() => ({ actor: { userId: null as string | null, source: "web" } }));
vi.mock("@/server/auth/session", () => ({ actorFromRequest: async () => session.actor }));

const { GET: previewRoute } = await import("@/app/(app)/nastaveni/designy/nahled/route");

// Rendering is CPU bound and competes with the other test workers.
vi.setConfig({ testTimeout: 60_000 });

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const TODAY = "2026-03-10";
const NOW = new Date("2026-03-10T10:00:00Z");
const SNAPSHOT_SCALE = 1.25;
const LOGO_RGB = [0x14, 0x53, 0x2d] as const;
const ACCENT = "#ff00aa";
const ACCENT_RGB = [0xff, 0x00, 0xaa] as const;

const F = INVOICE_FIXTURES;
const FIXTURE_NAMES = Object.keys(F) as (keyof typeof F)[];
const designIds = DESIGNS.map((design) => design.id);
const combinations = designIds.flatMap((id) => FIXTURE_NAMES.map((name) => [id, name] as const));

const readLogo = (id: string) => (id === FIXTURE_LOGO_ID ? FIXTURE_LOGO_SVG : null);

const withDesign = (
  doc: InvoiceDocument,
  designId: string,
  over: Partial<InvoiceDocument["appearance"]> = {},
): InvoiceDocument => ({ ...doc, appearance: { ...doc.appearance, designId, ...over } });

const render = async (doc: InvoiceDocument) =>
  renderInvoicePdf(
    await buildInvoiceView(doc, { today: TODAY, draft: false, readImage: readLogo }),
  );

function pixelBox(png: Buffer, rgb: readonly [number, number, number]) {
  const { data, width, height } = PNG.sync.read(png);
  let left = width;
  let right = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2]) {
      const x = (i / 4) % width;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return { left, right, width, height };
}

const squeeze = (text: string) => text.replace(/\s+/g, "").toLowerCase();

let ownerCounter = 0;

function newOwner() {
  const owner = `dsg${(ownerCounter += 1)}`;
  const now = new Date();
  db.insert(user)
    .values({
      id: owner,
      name: owner,
      email: `${owner}@example.cz`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ensureDefaultSeries(actor(owner));
  return owner;
}

function withSupplier(owner: string) {
  saveSupplier(actor(owner), {
    name: "Jana Svobodová",
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
  saveBankAccount(actor(owner), {
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "CZ6508000000192000145399",
    swift: "",
  });
}

function issueOne(owner: string, customerName: string) {
  const customerId = saveCustomer(actor(owner), {
    name: customerName,
    street: "Krátká 2",
    city: "Brno",
    zip: "602 00",
    country: "Česká republika",
    ico: "",
    dic: "",
    email: "",
    extraEmails: [],
    phone: "",
    note: "",
    dueDays: null,
    language: null,
    currency: null,
    designId: null,
    remindersEnabled: null,
  }).id;
  const { id, revision } = saveDraft(actor(owner), {
    ...newDraftDefaults(owner, customerId),
    lines: [
      {
        catalogItemId: null,
        name: "Skutečná položka",
        description: "",
        quantityMilli: 1000,
        unit: "ks",
        unitPriceMinor: 10_000,
        discountKind: "none",
        discountValue: 0,
      },
    ],
  });
  issueInvoice(actor(owner), id, { revision });
  return id;
}

const previewPdf = async (query = "") => {
  const response = await previewRoute(
    new Request(`http://localhost:3000/nastaveni/designy/nahled${query}`),
  );
  return response;
};

const textOfResponse = async (response: Response) =>
  (await pdfText(Buffer.from(await response.arrayBuffer()))).join("\n");

beforeEach(() => {
  setClockForTests({ now: () => NOW });
  session.actor = { userId: null, source: "web" };
});
afterEach(() => setClockForTests(null));

describe("registr designů", () => {
  test("[PDF-002] registr má aspoň 12 designů s unikátním ID", () => {
    expect(DESIGNS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(designIds).size).toBe(DESIGNS.length);
    expect(DESIGNS.map((design) => design.name)).toEqual(
      expect.arrayContaining([
        "Čistý",
        "Editorial",
        "Barevný pás",
        "Tabulkový",
        "Blok",
        "Minimal",
        "Mono",
        "Klasik",
        "Geometric",
        "Kontrast",
        "Boční pruh",
        "Kompaktní",
      ]),
    );
  });

  test("[PDF-002] výchozí barvy designu drží čitelný text", () => {
    for (const { id, tokens } of DESIGNS) {
      const { text, surface, accent } = tokens.colors;
      expect(contrastRatio(text, "#ffffff"), id).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(contrastRatio(text, surface), id).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(contrastRatio(accent, "#ffffff"), id).toBeGreaterThanOrEqual(3);
    }
  });

  test("[PDF-008] designs/index.ts nepotřebuje jiný seznam než DESIGNS", () => {
    const root = join(process.cwd(), "src");
    const dir = join(root, "server/pdf/designs");
    const files = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    expect(files.length).toBe(DESIGNS.length);
    for (const file of files) {
      expect(index).toContain(`"./${file.replace(".tsx", "")}"`);
    }

    const others = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (name) =>
        /\.tsx?$/.test(name) &&
        !name.startsWith("server/pdf/designs/") &&
        !name.startsWith("app/(app)/nastaveni/designy/"),
    );
    const ids = designIds.filter((id) => id !== "cisty");
    for (const name of others) {
      const source = readFileSync(join(root, name), "utf8");
      for (const id of ids) expect(source, name).not.toContain(`"${id}"`);
    }
  });

  test("[UI-004] barvy dokladů jsou jen v tokenech designů", () => {
    const hex = /#[0-9a-fA-F]{3,8}\b/;
    const dir = join(process.cwd(), "src/server/pdf");
    expect(readFileSync(join(dir, "parts.tsx"), "utf8")).not.toMatch(hex);
    for (const file of readdirSync(join(dir, "designs"))) {
      if (!file.endsWith(".tsx")) continue;
      const source = readFileSync(join(dir, "designs", file), "utf8");
      const code = source.slice(source.indexOf("\nfunction "));
      expect(code, file).not.toMatch(hex);
    }
  });
});

describe("[PDF-007] vizuální regrese", () => {
  test.each(combinations)("[PDF-007] %s / %s odpovídá referenci", async (designId, name) => {
    const pdf = await render(withDesign(F[name], designId));

    expectMatchesSnapshot(await pdfPagePng(pdf, 1, SNAPSHOT_SCALE), `${designId}-${name}`);
  });
});

describe.each(designIds)("design %s", (designId) => {
  test("[PDF-003] vykreslí vlastní barvy, logo vlevo, vpravo i bez a QR", async () => {
    const colors = { accent: ACCENT, surface: "#e0f2fe", text: "#0c0a09", line: "#10b981" };
    const page = async (logoPosition: "left" | "right" | "none") =>
      pdfPagePng(await render(withDesign(F.short, designId, { colors, logoPosition })), 1);

    const [left, right, none] = await Promise.all([page("left"), page("right"), page("none")]);

    const logoLeft = pixelBox(left, LOGO_RGB);
    const logoRight = pixelBox(right, LOGO_RGB);
    expect(logoLeft.right).toBeGreaterThan(0);
    expect(logoLeft.left + logoLeft.right).toBeLessThan(logoRight.left + logoRight.right);
    expect(logoLeft.left).toBeLessThan(logoLeft.width / 2);
    expect(logoRight.right).toBeGreaterThan(logoRight.width / 2);
    expect(pixelBox(none, LOGO_RGB).right).toBe(-1);
    expect(pixelBox(none, ACCENT_RGB).right).toBeGreaterThan(0);
    expect(decodeQr(left)).toContain("X-VS:2026001");
  });

  test("[TST-015] QR v PDF se dekóduje", async () => {
    const pdf = await render(withDesign(F.short, designId));

    const payload = decodeQr(await pdfPagePng(pdf, 1, 2));

    expect(payload).toContain("AM:3000.00");
    expect(payload).toContain("X-VS:2026001");
  });

  test("[PDF-003] česky i anglicky s podpisem jsou v PDF všechny povinné údaje", async () => {
    const images = { ...F.short.images, signatureFileId: FIXTURE_LOGO_ID };
    for (const [doc, expected] of [
      [F.short, ["Faktura", "Dodavatel", "Odběratel", "Datum splatnosti", "Variabilní symbol"]],
      [F.english, ["Invoice", "Supplier", "Customer", "Due date", "Payment reference"]],
    ] as const) {
      const text = squeeze(
        (
          await pdfText(
            await render(withDesign({ ...doc, images }, designId, { showSignature: true })),
          )
        ).join("\n"),
      );
      for (const value of [
        ...expected,
        "2026-001",
        "Jan Novák",
        "Dlouhá 1",
        "27082440",
        "CZ12345678",
        "19-2000145399/0800",
        "CZ65 0800 0000 1920 0014 5399",
      ]) {
        expect(text, value).toContain(squeeze(value));
      }
    }
  });

  test("[PDF-002] opakovaný render nezmění text ani obraz plné plochy", async () => {
    const doc = withDesign(F.short, designId);

    const first = await render(doc);
    const second = await render(doc);

    expect(await pdfText(second)).toEqual(await pdfText(first));
    expect((await pdfPagePng(second, 1)).equals(await pdfPagePng(first, 1))).toBe(true);
  });

  test("[PDF-002] krátká faktura se vejde na jednu stranu", async () => {
    const pages = await pdfText(await render(withDesign(F.short, designId)));

    expect(pages).toHaveLength(1);
  });

  test("[PDF-005] 300 položek s patičkou: nic se nepřekrývá a záhlaví je na každé straně", async () => {
    const footer = "SPISOVÁ ZNAČKA A BANKOVNÍ SPOJENÍ DODAVATELE. ".repeat(30).slice(0, 1000);
    const pdf = await render(
      withDesign(
        {
          ...F.long,
          snapshot: {
            ...F.long.snapshot,
            supplier: { ...F.long.snapshot.supplier!, footerText: footer },
          },
        },
        designId,
      ),
    );

    const pages = await pdfText(pdf);
    const all = pages.join("\n");
    for (let i = 1; i <= 300; i++) expect(all).toContain(`Položka ${String(i).padStart(3, "0")}`);
    for (let page = 1; page <= pages.length; page++) {
      const text = pages[page - 1]!;
      if (text.includes("Položka")) expect(text).toMatch(/Množství/i);
      expect(text).toContain(`Strana ${page} z ${pages.length}`);
      const items = await pdfTextItems(pdf, page);
      const footerTop = Math.max(
        ...items.filter((item) => /SPISOV|ZNAČK|BANK|SPOJEN/.test(item.text)).map((i) => i.top),
      );
      const content = items.filter((item) =>
        /^(Položka|Popis|POPIS|Nejsem|Zapsán|Poznámka|Platební|Děkujeme)/.test(item.text),
      );
      expect(content.length, `strana ${page}`).toBeGreaterThan(0);
      expect(Math.min(...content.map((item) => item.bottom))).toBeGreaterThan(footerTop);
    }
  });

  test("[PDF-005] limitní částka se nerozdělí", async () => {
    const netMinor = 99_999_999_999;
    const doc: InvoiceDocument = {
      ...F.short,
      lines: [fixtureLine({ quantityMilli: 1000, unitPriceMinor: netMinor, netMinor })],
      totals: { ...F.short.totals, subtotalMinor: netMinor, totalMinor: netMinor },
    };

    const text = (await pdfText(await render(withDesign(doc, designId)))).join("\n");

    expect(text.match(/999\s999\s999,99\sKč/g)).toHaveLength(3);
  });

  test("[PDF-005] záhlaví tabulky nezůstane samo na konci strany", async () => {
    const short = F.long.lines.slice(0, 3);
    const tall = [fixtureLine({ description: "Popis položky. ".repeat(30) }), ...short];
    for (const lines of [short, tall]) {
      for (let rows = 14; rows <= 56; rows += 3) {
        const pdf = await render(
          withDesign(
            {
              ...F.long,
              lines,
              textBefore: Array.from({ length: rows }, (_, i) => `řádek ${i}`).join("\n"),
            },
            designId,
          ),
        );
        for (const page of await pdfText(pdf)) {
          if (/Množství/i.test(page)) expect(page, `${rows} řádků`).toMatch(/Položka|Konzultace/);
        }
      }
    }
  });
});

describe("barvy vystaveného dokladu", () => {
  test("[PDF-003] vystavený doklad drží barvy a design z appearance", async () => {
    const owner = newOwner();
    withSupplier(owner);
    savePreferences(actor(owner), { designId: "kontrast", accentColor: "#112233" });
    const id = issueOne(owner, "Alfa s.r.o.");

    savePreferences(actor(owner), {
      designId: "mono",
      accentColor: "#445566",
      surfaceColor: "#eeeeee",
    });

    const view = await buildInvoiceView(loadInvoiceDocument(owner, id)!, {
      today: TODAY,
      draft: false,
      readImage: () => null,
    });
    const kontrast = DESIGNS.find((design) => design.id === "kontrast")!;
    expect(view.designId).toBe("kontrast");
    expect(view.colors.accent).toBe("#112233");
    expect(view.colors.surface).toBe(kontrast.tokens.colors.surface);
  });
});

describe("náhled designu", () => {
  test("[PDF-004] ukázková data nesou údaje uživatele a výchozí vzhled", () => {
    const owner = newOwner();
    withSupplier(owner);
    setSupplierImage(actor(owner), "logo", FIXTURE_LOGO_SVG, "logo.svg");
    savePreferences(actor(owner), { designId: "blok", language: "en" });

    const doc = samplePreviewDocument(owner);

    expect(doc.snapshot.supplier?.name).toBe("Jana Svobodová");
    expect(doc.snapshot.account?.number).toBe("19-2000145399");
    expect(doc.images.logoFileId).not.toBeNull();
    expect(doc.appearance.designId).toBe("blok");
    expect(doc.language).toBe("en");
    expect(doc.status).toBe("issued");
    expect(doc.lines.length).toBeGreaterThan(0);
    expect(doc.totals.totalMinor).toBe(doc.lines.reduce((sum, line) => sum + line.netMinor, 0));
  });

  test("[PDF-004] nepřihlášený dostane 404, špatná barva 400", async () => {
    expect((await previewPdf()).status).toBe(404);
    session.actor = actor(newOwner());
    expect((await previewPdf("?accent=red")).status).toBe(400);
    expect((await previewPdf("?logo=nahore")).status).toBe(400);
  });

  test("[PDF-004] bez dokladu ukáže ukázková data a použije parametry náhledu", async () => {
    const owner = newOwner();
    withSupplier(owner);
    session.actor = actor(owner);

    const response = await previewPdf(`?design=mono&accent=%23ff00aa&logo=right`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline; /);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const data = Buffer.from(await response.arrayBuffer());
    expect((await pdfText(data)).join("\n")).toContain("Jana Svobodová");
    expect(pixelBox(await pdfPagePng(data, 1), ACCENT_RGB).right).toBeGreaterThan(0);
  });

  test("[PDF-004] s dokladem ukáže poslední vystavený a preference nezmění", async () => {
    const owner = newOwner();
    withSupplier(owner);
    issueOne(owner, "Starší s.r.o.");
    setClockForTests({ now: () => new Date("2026-03-11T10:00:00Z") });
    issueOne(owner, "Novější s.r.o.");
    session.actor = actor(owner);
    const before = getPreferences(owner);

    const text = await textOfResponse(await previewPdf("?design=kontrast"));

    expect(text).toContain("Novější s.r.o.");
    expect(getPreferences(owner)).toEqual(before);
  });

  test("[PDF-004] cizí doklad se v náhledu neobjeví", async () => {
    const owner = newOwner();
    withSupplier(owner);
    issueOne(owner, "Cizí s.r.o.");
    const stranger = newOwner();
    withSupplier(stranger);
    session.actor = actor(stranger);

    expect(await textOfResponse(await previewPdf())).not.toContain("Cizí s.r.o.");
  });
});
