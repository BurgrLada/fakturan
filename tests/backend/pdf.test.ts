import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { setClockForTests } from "@/server/clock";
import { auditLog, user } from "@/server/db/schema";
import { FONT_FAMILIES, registerFonts } from "@/server/pdf/fonts";
import { DESIGNS, getDesign, isDesignId } from "@/server/pdf/designs";
import { RenderTimeoutError, renderInvoicePdf, serializeRender } from "@/server/pdf/render";
import { buildInvoiceView } from "@/server/pdf/view";
import { checkRateLimit, RATE_RULES } from "@/server/rate-limit";
import { saveBankAccount } from "@/server/services/bank-accounts";
import { saveCustomer } from "@/server/services/customers";
import { loadInvoiceDocument } from "@/server/services/invoice-document";
import { fileNameFor } from "@/server/pdf/file-name";
import {
  documentPdf,
  invoicePdf,
  PDF_TEXT_BUDGET,
  printedLength,
} from "@/server/services/invoice-pdf";
import { PdfTooLong } from "@/server/services/access";
import { DOCUMENT_INPUT_BYTES, jsonBytes } from "@/lib/backup-format";
import { DOCUMENT_FRAME_CHARS } from "@/lib/printed-length";
import { TEXTS } from "@/lib/texts";
import { invoiceLine } from "@/server/db/schema";
import { designPreviewPdf } from "@/server/services/design-preview";
import { cancelInvoice, checkIssuable, issueInvoice } from "@/server/services/invoice-lifecycle";
import { listVersions, updateIssuedInvoice } from "@/server/services/invoice-versions";
import {
  getInvoice,
  newDraftDefaults,
  saveDraft,
  type DraftInput,
} from "@/server/services/invoices";
import { ensureDefaultSeries } from "@/server/services/number-series";
import { savePreferences } from "@/server/services/preferences";
import { saveSupplier, setSupplierImage, type SupplierInput } from "@/server/services/supplier";
import {
  FIXTURE_LOGO_ID,
  FIXTURE_LOGO_SVG,
  INVOICE_FIXTURES,
  fixtureLine,
} from "../fixtures/invoices";
import { createTestDb } from "../helpers/db";
import { decodeQr, pdfPagePng, pdfText, pdfTextItems } from "../helpers/pdf";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-pdf-")));

const session = vi.hoisted(() => ({ actor: { userId: null as string | null, source: "web" } }));
vi.mock("@/server/auth/session", () => ({ actorFromRequest: async () => session.actor }));

const { GET: pdfRoute } = await import("@/app/(app)/faktury/[id]/pdf/route");
const { GET: previewRoute } = await import("@/app/(app)/faktury/[id]/nahled/route");
const { GET: versionRoute } = await import("@/app/(app)/faktury/[id]/verze/[versionId]/pdf/route");

// Rendering is CPU bound and competes with the other test workers.
vi.setConfig({ testTimeout: 30_000 });

const db = createTestDb();
const actor = (userId: string) => ({ userId, source: "web" as const });
const NOW = new Date("2026-03-10T10:00:00Z");
const TODAY = "2026-03-10";
const F = INVOICE_FIXTURES;

let ownerCounter = 0;

const supplierInput: SupplierInput = {
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
};

function newOwner() {
  const owner = `pdf${(ownerCounter += 1)}`;
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
  saveSupplier(actor(owner), supplierInput);
  const customerId = saveCustomer(actor(owner), {
    name: "Alfa s.r.o.",
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
  const accountId = saveBankAccount(actor(owner), {
    name: "Účet",
    currency: "CZK",
    number: "19-2000145399",
    bankCode: "0800",
    iban: "",
    swift: "",
  });
  return { owner, customerId, accountId };
}

function draft(owner: string, customerId: string, over: Partial<DraftInput> = {}) {
  return saveDraft(actor(owner), {
    ...newDraftDefaults(owner, customerId),
    lines: [
      {
        catalogItemId: null,
        name: "Konzultace",
        description: "",
        quantityMilli: 2000,
        unit: "hod.",
        unitPriceMinor: 150_000,
        discountKind: "none",
        discountValue: 0,
      },
    ],
    ...over,
  });
}

function issued(owner: string, customerId: string, over: Partial<DraftInput> = {}) {
  const { id, revision } = draft(owner, customerId, over);
  issueInvoice(actor(owner), id, { revision });
  return id;
}

const FOOTER_WORDS = /^(?!Dodavatel$).*(spis|značk|bank|spoj|dodav)/i;

const readLogo = (id: string) => (id === FIXTURE_LOGO_ID ? FIXTURE_LOGO_SVG : null);

const viewOf = (doc: InvoiceDocument, draftFlag = false) =>
  buildInvoiceView(doc, { today: TODAY, draft: draftFlag, readImage: readLogo });

const render = async (doc: InvoiceDocument, draftFlag = false) =>
  renderInvoicePdf(await viewOf(doc, draftFlag));

const textOf = async (pdf: Buffer) => (await pdfText(pdf)).join("\n");
const squeeze = (text: string) => text.replace(/\s+/g, "");

const request = (path: string) => new Request(`http://localhost:3000${path}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  setClockForTests({ now: () => NOW });
  session.actor = { userId: null, source: "web" };
});
afterEach(() => setClockForTests(null));

describe("vykreslení PDF", () => {
  test("[FOR-006] PDF vytiskne doložku a VAT ID obou stran", async () => {
    const doc: InvoiceDocument = {
      ...F.short,
      language: "en",
      clause: "Reverse charge clause.",
      snapshot: {
        ...F.short.snapshot,
        supplier: { ...F.short.snapshot.supplier!, dic: "CZ27082440" },
        customer: { ...F.short.snapshot.customer!, dic: "DE123456789" },
      },
    };
    const text = await textOf(await render(doc));
    expect(text).toContain("Reverse charge clause.");
    expect(text).toContain("CZ27082440");
    expect(text).toContain("DE123456789");
    expect(text.match(/VAT ID/g)).toHaveLength(2);
    expect(text.indexOf("Reverse charge clause.")).toBeLessThan(
      text.indexOf("I am not a VAT payer"),
    );
  });

  test("[INV-041] doklad bez doložky má shodný text PDF jako dřív", async () => {
    expect((await viewOf(F.short)).clause).toBe("");
    const without = await textOf(await render(F.short));
    const withClause = await textOf(await render({ ...F.short, clause: "Doložka navíc" }));
    expect(without).not.toContain("Doložka navíc");
    expect(withClause.replace("Doložka navíc\n", "")).toBe(without);
  });

  test("[PDF-001] náhled a stažení dají stejný text", async () => {
    const { owner, customerId } = newOwner();
    const id = issued(owner, customerId);
    session.actor = actor(owner);

    const download = await pdfRoute(request(`/faktury/${id}/pdf`), params(id));
    const preview = await previewRoute(request(`/faktury/${id}/nahled`), params(id));

    expect(download.status).toBe(200);
    expect(preview.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; .*filename\*=UTF-8''/,
    );
    expect(preview.headers.get("content-disposition")).toMatch(/^inline; /);
    const [a, b] = await Promise.all([download.arrayBuffer(), preview.arrayBuffer()]);
    expect(await pdfText(Buffer.from(a))).toEqual(await pdfText(Buffer.from(b)));
  });

  test("[INV-021] verze se vykreslí z vlastního obsahu a cizí verze je 404", async () => {
    const { owner, customerId } = newOwner();
    const id = issued(owner, customerId, { note: "Původní poznámka" });
    const row = getInvoice(owner, id)!;
    updateIssuedInvoice(actor(owner), id, { ...row, number: row.number!, note: "Nová poznámka" });
    const versionId = listVersions(owner, id)[0]!.id;
    const url = request(`/faktury/${id}/verze/${versionId}/pdf`);
    const context = { params: Promise.resolve({ id, versionId }) };

    session.actor = actor(owner);
    const own = await versionRoute(url, context);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-disposition")).toMatch(/^inline; /);
    const text = await textOf(Buffer.from(await own.arrayBuffer()));
    expect(text).toContain("Původní poznámka");
    expect(text).not.toContain("Nová poznámka");

    session.actor = actor(newOwner().owner);
    expect((await versionRoute(url, context)).status).toBe(404);
    session.actor = actor(owner);
    const other = issued(owner, customerId);
    const mismatch = { params: Promise.resolve({ id: other, versionId }) };
    expect((await versionRoute(url, mismatch)).status).toBe(404);
  });

  test("[PDF-001] rendery běží za sebou a chyba jednoho neblokuje další", async () => {
    const order: string[] = [];
    let release = () => {};
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const first = serializeRender(async () => {
      order.push("první start");
      await blocker;
      order.push("první konec");
      throw new Error("selhání renderu");
    });
    const second = serializeRender(async () => {
      order.push("druhý");
      return "hotovo";
    });

    release();

    await expect(first).rejects.toThrow("selhání renderu");
    await expect(second).resolves.toBe("hotovo");
    expect(order).toEqual(["první start", "první konec", "druhý"]);
  });

  test("[PDF-001] render po timeoutu uvolní frontu a volající dostane chybu", async () => {
    const hung = serializeRender(() => new Promise<string>(() => {}), 5);
    const next = serializeRender(async () => "další");

    await expect(hung).rejects.toBeInstanceOf(RenderTimeoutError);
    await expect(next).resolves.toBe("další");
  });

  test("[PDF-001] synchronní chyba renderu zruší časovač a nezanechá nezachycené odmítnutí", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const failed = serializeRender((): Promise<string> => {
        throw new Error("synchronní selhání");
      }, 5);

      await expect(failed).rejects.toThrow("synchronní selhání");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("[PDF-001] vadný pohled shodí jen svůj render", async () => {
    const good = await viewOf(F.short);
    const broken = renderInvoicePdf({ ...good, lines: null as never });
    const next = renderInvoicePdf(good);

    await expect(broken).rejects.toThrow();
    expect(await textOf(await next)).toContain("2026-001");
  });

  test("[PDF-005] 300 položek: všechny řádky jsou v PDF, záhlaví na každé straně, Strana X z Y", async () => {
    const pages = await pdfText(await render(F.long));

    expect(pages.length).toBeGreaterThan(5);
    const all = pages.join("\n");
    for (let i = 1; i <= 300; i++) {
      expect(all).toContain(`Položka ${String(i).padStart(3, "0")}`);
    }
    pages.forEach((page, index) => {
      if (page.includes("Položka")) expect(page).toContain("Množství");
      expect(page).toContain(`Strana ${index + 1} z ${pages.length}`);
    });
  });

  test.each([
    ["běžná", "Spisová značka a bankovní spojení dodavatele. "],
    ["velká písmena", "SPISOVÁ ZNAČKA A BANKOVNÍ SPOJENÍ DODAVATELE. "],
  ])("[PDF-005] patička 1000 znaků (%s) se nepřekrývá s položkami", async (_, sentence) => {
    const footer = sentence.repeat(30).slice(0, 999) + "K";
    const pdf = await render({
      ...F.long,
      snapshot: {
        ...F.long.snapshot,
        supplier: { ...F.long.snapshot.supplier!, footerText: footer },
      },
    });

    const pages = await pdfText(pdf);
    for (let page = 1; page <= pages.length; page++) {
      const items = await pdfTextItems(pdf, page);
      const footerTop = Math.max(
        ...items.filter((item) => FOOTER_WORDS.test(item.text)).map((item) => item.top),
      );
      const content = items.filter((item) => /^(Položka|Popis|Nejsem|Zapsán)/.test(item.text));
      expect(content.length, `strana ${page}`).toBeGreaterThan(0);
      expect(Math.min(...content.map((item) => item.bottom))).toBeGreaterThan(footerTop);
      expect(squeeze(pages[page - 1]!)).toContain(squeeze(footer));
    }
    const all = pages.join("\n");
    for (let i = 1; i <= 300; i++) expect(all).toContain(`Položka ${String(i).padStart(3, "0")}`);
  });

  test.each([
    ["běžná", 999_999_900, 999_999_900],
    ["limitní", 99_999_999_999, 99_999_999_999],
  ])("[PDF-005] částka %s se nerozdělí", async (_, unitPriceMinor, netMinor) => {
    const doc: InvoiceDocument = {
      ...F.short,
      lines: [fixtureLine({ quantityMilli: 1000, unitPriceMinor, netMinor })],
      totals: { ...F.short.totals, subtotalMinor: netMinor, totalMinor: netMinor },
    };
    const amount = netMinor === 999_999_900 ? "9\\s999\\s999,00" : "999\\s999\\s999,99";

    const text = await textOf(await render(doc));

    const unbroken = new RegExp(`${amount}\\sKč`, "g");
    expect(text.match(unbroken)).toHaveLength(3);
  });

  test(
    "[PDF-005] záhlaví tabulky nezůstane samo na konci strany",
    { timeout: 60_000 },
    async () => {
      const short = F.long.lines.slice(0, 3);
      const tall = [fixtureLine({ description: "Popis položky. ".repeat(30) }), ...short];
      for (const lines of [short, tall]) {
        for (let rows = 20; rows <= 36; rows++) {
          const pdf = await render({
            ...F.long,
            lines,
            textBefore: Array.from({ length: rows }, (_, i) => `řádek ${i}`).join("\n"),
          });
          for (const page of await pdfText(pdf)) {
            if (page.includes("Množství")) {
              expect(page, `${rows} řádků`).toMatch(/Položka|Konzultace/);
            }
          }
        }
      }
    },
  );

  test("[PDF-005] popis 2000 znaků a slovo 200 znaků bez mezer: text je celý v PDF", async () => {
    const description = `${"Dlouhý popis s háčky a čárkami. ".repeat(63)}Konec.`.slice(-2000);
    const word = "ž".repeat(200);
    const doc = {
      ...F.short,
      lines: [
        fixtureLine({ name: "První", description }),
        fixtureLine({ name: word, description: word }),
      ],
    };

    const text = squeeze(await textOf(await render(doc)))
      .replace(/PopisMnožstvíCenazajednotkuCelkem/g, "")
      .replace(/Strana\dz\d/g, "")
      .replace(/2hod\.1500,00Kč3000,00Kč/g, "");

    expect(description.length).toBe(2000);
    expect(text).toContain(squeeze(description));
    expect(text.split(word).length).toBe(3);
  });

  test("[PDF-005] popis s mnoha řádky se zalomí přes stranu a nic se neztratí", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => `řádek ${i + 1}`);
    const doc = { ...F.short, lines: [fixtureLine({ description: rows.join("\n") })] };

    const pages = await pdfText(await render(doc));

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("\n")).toContain("řádek 90");
  });

  test("[PDF-006] české znaky i zł a € přežijí extrakcí textu", async () => {
    const sample = "Příliš žluťoučký kůň úpěl ďábelské ódy ŘŮĚ Łódź 5 £ 7 € 9 zł";
    const pln = await render({
      ...F.short,
      currency: "PLN",
      lines: [fixtureLine({ name: sample })],
    });
    const eur = await render(F.eur);

    const text = await textOf(pln);
    expect(squeeze(text)).toContain(squeeze(sample));
    expect(text).toMatch(/3\s000,00\sPLN/);
    expect(await textOf(eur)).toMatch(/3\s000,00\s€/);
  });

  test("[PDF-006] písmena složených znaků přežijí i další render v procesu", async () => {
    const accented = fixtureLine({ name: "ý Č", description: "ý Č" });
    const plain = fixtureLine({ name: "yC", description: "yC" });

    await render({ ...F.short, lines: [accented] });
    const text = await textOf(await render({ ...F.short, lines: [plain] }));

    expect(text.split("yC").length).toBe(3);
    expect(text).toContain("CZ12345678");
  });

  test.each(FONT_FAMILIES)("[PDF-006] písmo %s je vložené v obou řezech", async (family) => {
    registerFonts();
    const sample = "ř ů ě ł £ € zł";
    for (const fontWeight of [400, 700]) {
      const pdf = await renderToBuffer(
        createElement(
          Document,
          null,
          createElement(
            Page,
            { size: "A4" },
            createElement(Text, { style: { fontFamily: family, fontWeight } }, sample),
          ),
        ),
      );
      expect(await textOf(pdf)).toContain(sample);
    }
  });

  test("[PDF-006] úzká nezlomitelná mezera nevypadne ani z neproporcionálního písma", async () => {
    const view = await viewOf({
      ...F.short,
      lines: [fixtureLine({ name: "10 000 kusů" })],
    });

    expect(view.lines[0]!.name).toBe("10 000 kusů");
  });

  test("[PDF-006] znak mimo písmo render neshodí", async () => {
    const pdf = await render({ ...F.short, lines: [fixtureLine({ name: "Dort 🎂 漢字" })] });

    expect(await textOf(pdf)).toContain("Dort");
  });

  test("[PDF-001] v angličtině jsou popisky, částka i datum anglicky", async () => {
    const text = await textOf(await render(F.english));

    expect(text).toContain("Invoice");
    expect(text).toContain("Due date");
    expect(text).toContain("2026-03-24");
    expect(text).toContain("I am not a VAT payer.");
    expect(text).toMatch(/CZK\s3,000\.00/);
    expect(text).not.toContain("Splatnost");
  });

  test("[PDF-001] datum se řídí formátem dokladu", async () => {
    const text = await textOf(await render({ ...F.short, dateFormat: "dd.MM.yyyy" }));

    expect(text).toContain("24.03.2026");
  });

  test("[PDF-001] neznámý design spadne na cisty", async () => {
    expect(isDesignId("cisty")).toBe(true);
    expect(isDesignId("neexistuje")).toBe(false);
    expect(getDesign("neexistuje").id).toBe("cisty");
    expect(DESIGNS.map((design) => design.id)).toContain("cisty");
    const doc = {
      ...F.short,
      appearance: { ...F.short.appearance, designId: "neexistuje" },
    };
    expect(await textOf(await render(doc))).toContain("2026-001");
  });

  test("[PDF-001] prázdná barva vezme token designu, vlastní barva se použije", async () => {
    const custom = await viewOf({
      ...F.short,
      appearance: {
        ...F.short.appearance,
        colors: { accent: "#ff0000", surface: "", text: "", line: "" },
      },
    });

    expect(custom.colors.accent).toBe("#ff0000");
    expect(custom.colors.text).toBe(getDesign("cisty").tokens.colors.text);
  });

  test("[PDF-001] koncept má vodoznak a prázdné číslo, koncept bez dat vezme dnešek", async () => {
    const pdf = await render(
      { ...F.short, status: "draft", number: null, variableSymbol: null, issueDate: null },
      true,
    );

    const text = await textOf(pdf);
    expect(text).toContain("Koncept");
    expect(text).toContain("10. 3. 2026");
    expect(text).not.toContain("2026-001");
  });

  test("[QR-005] koncept místo QR ukáže text a číslo ani VS nemá", async () => {
    const doc = { ...F.short, status: "draft" as const, number: null, variableSymbol: null };

    const view = await viewOf(doc, true);

    expect(view.payment.qr).toBeNull();
    expect(view.payment.qrPending).toBe(true);
    expect(await textOf(await renderInvoicePdf(view))).toContain("QR po vystavení");

    const off = await viewOf({ ...doc, appearance: { ...doc.appearance, showQr: false } }, true);
    expect(off.payment.qrPending).toBe(false);
  });

  test("[PDF-001] stornovaný doklad je označený a nemá QR", async () => {
    const view = await viewOf({ ...F.short, status: "cancelled" });

    expect(view.watermark).toBe("Stornováno");
    expect(view.payment.qr).toBeNull();
  });
});

describe("QR na dokladu", () => {
  test("[QR-006] QR nese zbývající částku a dekóduje se", async () => {
    const view = await viewOf({
      ...F.short,
      status: "partially_paid",
      totals: { ...F.short.totals, paidMinor: 100_000 },
    });

    const payload = decodeQr(view.payment.qr!);
    expect(payload).toContain("AM:2000.00");
    expect(payload).toContain("X-VS:2026001");
  });

  test("[QR-002] EUR doklad má EPC", async () => {
    const view = await viewOf(F.eur);

    expect(decodeQr(view.payment.qr!)).toMatch(/^BCD\n002/);
  });

  test("[QR-005] QR chybí, když je vypnuté, uhrazené nebo platba není převodem", async () => {
    const off = { ...F.short.appearance, showQr: false };
    const views = await Promise.all([
      viewOf({ ...F.short, appearance: off }),
      viewOf({ ...F.short, status: "paid" }),
      viewOf({ ...F.short, paymentMethod: "cash" }),
    ]);

    for (const view of views) expect(view.payment.qr).toBeNull();
  });

  test("[QR-001] převod bez účtu se vykreslí bez QR", async () => {
    const doc = { ...F.short, snapshot: { ...F.short.snapshot, account: null } };

    const view = await viewOf(doc);

    expect(view.payment.qr).toBeNull();
    expect(await textOf(await renderInvoicePdf(view))).toContain("2026-001");
  });

  test("[QR-004] logo v QR se použije jen se zapnutým přepínačem", async () => {
    const appearance = { ...F.short.appearance, showQrLogo: true };
    const images = { ...F.short.images, qrLogoFileId: FIXTURE_LOGO_ID };
    const plain = await viewOf({ ...F.short, images });
    const logo = await viewOf({ ...F.short, images, appearance });

    expect(plain.payment.qr!.equals(logo.payment.qr!)).toBe(false);
    expect(decodeQr(logo.payment.qr!)).toBe(decodeQr(plain.payment.qr!));
  });
});

describe("obrázky", () => {
  test("[SET-014] SVG i WebP se převedou na PNG nejvýš 800 px široké", async () => {
    const sharp = (await import("sharp")).default;
    const webp = await sharp({
      create: { width: 1600, height: 400, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .webp()
      .toBuffer();
    const { imageToPng } = await import("@/server/pdf/assets");

    for (const source of [FIXTURE_LOGO_SVG, webp]) {
      const png = await imageToPng(source);
      const meta = await sharp(png!).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBeLessThanOrEqual(800);
    }
  });

  test("[SET-014] nečitelný nebo chybějící obrázek render neshodí", async () => {
    const doc = { ...F.short };
    const view = await buildInvoiceView(doc, {
      today: TODAY,
      draft: false,
      readImage: () => Buffer.from("to není obrázek"),
    });
    const missing = await buildInvoiceView(doc, {
      today: TODAY,
      draft: false,
      readImage: () => null,
    });

    expect(view.images.logo).toBeNull();
    expect(missing.images.logo).toBeNull();
    expect(await textOf(await renderInvoicePdf(view))).toContain("2026-001");
  });

  test("[INV-041] logo se vynechá při showLogo false i pozici none", async () => {
    const hidden = await viewOf({
      ...F.short,
      appearance: { ...F.short.appearance, showLogo: false },
    });
    const none = await viewOf({
      ...F.short,
      appearance: { ...F.short.appearance, logoPosition: "none" },
    });

    expect(hidden.images.logo).toBeNull();
    expect(none.images.logo).toBeNull();
  });
});

describe("název souboru", () => {
  test("[PDF-009] šablona {cislo}-{zakaznik}.pdf s lomítkem a uvozovkou dá bezpečný název", () => {
    const name = fileNameFor("{cislo}-{zakaznik}.pdf", {
      ...F.short,
      number: "2026/001",
      customerName: 'A"B\\C\r\nD/E s.r.o.',
    });

    expect(name).toBe("2026_001-A_B_C__D_E s.r.o.pdf");
  });

  test("[PDF-009] výchozí šablona, náhradní jméno konceptu, přípona a délka", () => {
    expect(fileNameFor("{cislo}.pdf", F.short)).toBe("2026-001.pdf");
    expect(fileNameFor("{cislo}.pdf", { ...F.short, number: null })).toBe("koncept.pdf");
    expect(fileNameFor("{cislo}", F.short)).toBe("2026-001.pdf");
    expect(fileNameFor("{zakaznik}.pdf", { ...F.short, customerName: "$& ..‮" })).toBe("$& ._.pdf");
    expect(fileNameFor("...", F.short)).toBe("faktura.pdf");
    expect(
      fileNameFor("{zakaznik}.pdf", { ...F.short, customerName: "x".repeat(500) }).length,
    ).toBeLessThanOrEqual(124);
  });
});

describe("povinné údaje", () => {
  test("[INV-040] vystavený doklad obsahuje všechny povinné údaje", async () => {
    const text = await textOf(await render(F.short));

    for (const expected of [
      "Faktura",
      "2026-001",
      "Jan Novák",
      "Dlouhá 1",
      "110 00 Praha",
      "27082440",
      "Příliš žluťoučký kůň s.r.o.",
      "Krátká 2",
      "602 00 Brno",
      "10. 3. 2026",
      "24. 3. 2026",
      "Konzultace",
      "Převodem",
      "2026001",
      "19-2000145399/0800",
      "CZ65 0800 0000 1920 0014 5399",
      "Nejsem plátce DPH.",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toMatch(/Celkem[\s\S]*3\s000,00\sKč/);
  });

  test.each([
    ["cs", "supplier.notVatPayerCs", "česky"],
    ["en", "supplier.notVatPayerEn", "anglicky"],
  ] as const)(
    "[INV-040] bez textu o neplátcovství (%s) nejde vystavit",
    (language, field, label) => {
      const { owner, customerId } = newOwner();
      saveSupplier(actor(owner), { ...supplierInput, [field.slice(9)]: "  " });
      const { id, revision } = draft(owner, customerId, { language });

      const problems = checkIssuable(owner, id);

      expect(problems).toEqual([
        { field, message: expect.stringMatching(new RegExp(`Dodavatel.*${label}`)) },
      ]);
      expect(() => issueInvoice(actor(owner), id, { revision })).toThrow(/Dodavatel/);

      const other = language === "cs" ? "en" : "cs";
      expect(checkIssuable(owner, draft(owner, customerId, { language: other }).id)).toEqual([]);
    },
  );

  test("[INV-041] volitelné údaje se vytisknou, jen když jsou vyplněné", async () => {
    const full = await textOf(await render(F.short));
    for (const expected of [
      "9. 3. 2026",
      "OBJ-77",
      "Zakázka Vltava",
      "Poznámka k dokladu",
      "Fakturujeme Vám",
      "Děkujeme za spolupráci",
      "Zapsán v živnostenském rejstříku v Praze",
      "jan@example.cz",
      "+420 777 123 456",
    ]) {
      expect(full).toContain(expected);
    }

    const bare = await textOf(
      await render({
        ...F.short,
        appearance: { ...F.short.appearance, showDuzp: false },
        orderRef: "",
        reference: "",
        note: "",
      }),
    );
    expect(bare).not.toContain("9. 3. 2026");
    expect(bare).not.toContain("Objednávka");
    expect(bare).not.toContain("Reference");
    expect(bare).not.toContain("Poznámka");
  });

  test("[INV-041] podpis se vloží jen se zapnutým přepínačem", async () => {
    const images = { ...F.short.images, signatureFileId: FIXTURE_LOGO_ID };
    const off = await viewOf({ ...F.short, images });
    const on = await viewOf({
      ...F.short,
      images,
      appearance: { ...F.short.appearance, showSignature: true },
    });

    expect(off.images.signature).toBeNull();
    expect(on.images.signature).not.toBeNull();
    await renderInvoicePdf(on);
  });

  test("[INV-041] slevy a zaokrouhlení jsou v součtech, sleva položky v tabulce", async () => {
    const text = await textOf(
      await render({
        ...F.short,
        lines: [fixtureLine({ discountKind: "percent", discountValue: 1250 })],
        totals: {
          subtotalMinor: 300_000,
          discountMinor: 10_000,
          roundingMinor: 33,
          totalMinor: 290_033,
          paidMinor: 90_033,
          creditsMinor: 0,
          advanceMinor: 0,
          supersededAt: null,
        },
      }),
    );

    expect(text).toMatch(/12,5\s%/);
    expect(text).toMatch(/Sleva[\s\S]*100,00\sKč/);
    expect(text).toMatch(/Zaokrouhlení[\s\S]*0,33\sKč/);
    expect(text).toMatch(/Uhrazeno[\s\S]*900,33\sKč/);
    expect(text).toMatch(/Zbývá uhradit[\s\S]*2\s000,00\sKč/);
  });

  test("PDF ukáže Přeplatek k vrácení 1 500,00", async () => {
    const view = await viewOf({
      ...F.short,
      totals: {
        ...F.short.totals,
        totalMinor: 500_000,
        subtotalMinor: 500_000,
        creditsMinor: -150_000,
        paidMinor: 500_000,
      },
    });

    expect(view.totals.map(({ label, strong }) => [label, strong])).toEqual([
      ["Celkem k úhradě", false],
      ["Opravné faktury", false],
      ["Uhrazeno", false],
      ["Přeplatek k vrácení", true],
    ]);
    expect(view.totals.at(-1)!.value).toMatch(/1\s500,00\sKč/);
    expect(view.totals.at(1)!.value).toMatch(/-\s?1\s500,00\sKč/);
    expect(await textOf(await renderInvoicePdf(view))).toMatch(
      /Přeplatek k vrácení[\s\S]*1\s500,00\sKč/,
    );
  });

  test("[ADV-001] záloha vytiskne text ze snapshotu v jazyce dokladu", async () => {
    const text = await textOf(
      await render({
        ...F.short,
        type: "advance",
        snapshot: {
          ...F.short.snapshot,
          supplier: { ...F.short.snapshot.supplier!, advanceNoteCs: "Vlastní text zálohy." },
        },
      }),
    );

    expect(text).toContain("Vlastní text zálohy.");
    expect(await textOf(await render(F.short))).not.toContain("daňový doklad");
  });

  test("[ADV-003] konečná faktura tiskne odkaz na zálohu", async () => {
    const text = await textOf(
      await render({
        ...F.short,
        relatedDocument: { type: "advance", number: "Z2026-001", issueDate: "2026-03-01" },
      }),
    );

    expect(text).toMatch(/Vyúčtování zálohy[\s\S]*Z2026-001/);
  });

  test("úhrada zálohou má řádek a zbytek je silný", async () => {
    const { totals } = await viewOf({
      ...F.english,
      totals: { ...F.english.totals, advanceMinor: 100_000 },
    });

    expect(totals.map(({ label, strong }) => [label, strong])).toEqual([
      ["Total due", false],
      ["Paid by advance", false],
      ["Amount due", true],
    ]);
  });

  test("doklad bez oprav, záloh a plateb má jediný silný řádek", async () => {
    const { totals } = await viewOf(F.short);

    expect(totals.map(({ label, strong }) => [label, strong])).toEqual([["Celkem k úhradě", true]]);
  });

  test.each([
    ["cs", /1\s000,00/],
    ["en", /1,000\.00/],
  ] as const)(
    "[INV-041] tiskne skutečně uplatněnou slevu položky, ne zadanou (%s)",
    async (language, applied) => {
      const view = await viewOf({
        ...F.short,
        language,
        lines: [
          fixtureLine({
            quantityMilli: 1000,
            unitPriceMinor: 100_000,
            discountKind: "amount",
            discountValue: 500_000,
            netMinor: 0,
          }),
        ],
      });

      expect(view.lines[0]?.discount).toMatch(applied);
    },
  );

  test("[INV-042] patička nemá značku aplikace", async () => {
    const pdf = await render({
      ...F.short,
      snapshot: {
        ...F.short.snapshot,
        supplier: { ...F.short.snapshot.supplier!, footerText: "Vlastní patička dodavatele" },
      },
    });

    const text = await textOf(pdf);
    expect(text).toContain("Vlastní patička dodavatele");
    expect(text.toLowerCase()).not.toContain("fakturan");
    expect(pdf.toString("latin1").toLowerCase()).not.toContain("fakturan");
    expect(pdf.toString("latin1").toLowerCase()).not.toContain("react-pdf");
  });
});

describe("bezpečnost", () => {
  test("[SEC-011] název <b>{{rok}}</b> je v PDF doslova", async () => {
    const hostile = "<b>{{rok}}</b>";
    const doc: InvoiceDocument = {
      ...F.short,
      customerName: hostile,
      textBefore: hostile,
      lines: [fixtureLine({ name: hostile, description: hostile })],
      snapshot: {
        ...F.short.snapshot,
        customer: { ...F.short.snapshot.customer!, name: hostile },
      },
    };

    const text = await textOf(await render(doc));

    expect(text.split(hostile).length).toBeGreaterThanOrEqual(5);
  });

  test("[CUS-008] změna adresy dodavatele a výměna loga nezmění PDF vystaveného dokladu", async () => {
    const { owner, customerId } = newOwner();
    setSupplierImage(actor(owner), "logo", FIXTURE_LOGO_SVG, "logo.svg");
    const id = issued(owner, customerId);
    const before = (await invoicePdf(owner, id)).data;

    saveSupplier(actor(owner), { ...supplierInput, street: "Nová 99", city: "Ostrava" });
    setSupplierImage(
      actor(owner),
      "logo",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ff0000"/></svg>',
      ),
      "nove.svg",
    );

    const after = (await invoicePdf(owner, id)).data;
    expect(await pdfText(after)).toEqual(await pdfText(before));
    expect(await textOf(after)).not.toContain("Nová 99");
    expect((await pdfPagePng(after, 1)).equals(await pdfPagePng(before, 1))).toBe(true);
  });

  test("[CUS-008] koncept ukazuje aktuální dodavatele", async () => {
    const { owner, customerId } = newOwner();
    const { id } = draft(owner, customerId);
    saveSupplier(actor(owner), { ...supplierInput, street: "Nová 99" });

    const { data, fileName } = await invoicePdf(owner, id);

    const text = await textOf(data);
    expect(text).toContain("Nová 99");
    expect(text).toContain("Koncept");
    expect(fileName).toBe("koncept.pdf");
  });

  test("[PDF-001] smazaný účet u konceptu render neshodí", async () => {
    const { owner, customerId, accountId } = newOwner();
    const { id } = draft(owner, customerId, { bankAccountId: accountId });
    const doc = loadInvoiceDocument(owner, id)!;

    const view = await buildInvoiceView(
      { ...doc, snapshot: { ...doc.snapshot, account: null } },
      { today: TODAY, draft: true, readImage: () => null },
    );

    expect(view.payment.qr).toBeNull();
  });

  test("[SEC-001] cizí uživatel dostane na PDF i náhled 404", async () => {
    const { owner, customerId } = newOwner();
    const { owner: stranger } = newOwner();
    const id = issued(owner, customerId);

    for (const route of [pdfRoute, previewRoute]) {
      session.actor = actor(stranger);
      expect((await route(request("/x"), params(id))).status).toBe(404);
      session.actor = { userId: null, source: "web" };
      expect((await route(request("/x"), params(id))).status).toBe(404);
      session.actor = actor(owner);
      expect((await route(request("/x"), params("neexistuje"))).status).toBe(404);
    }
    await expect(invoicePdf(stranger, id)).rejects.toThrow();
  });

  test("[AUD-002] stažení vystaveného dokladu se zaznamená, náhled a koncept ne", async () => {
    const { owner, customerId } = newOwner();
    const id = issued(owner, customerId);
    const { id: draftId } = draft(owner, customerId);
    session.actor = actor(owner);
    const downloads = () =>
      db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "invoice.pdf_download"))
        .all()
        .filter((row) => row.ownerId === owner);

    await previewRoute(request("/x"), params(id));
    await pdfRoute(request("/x"), params(draftId));
    expect(downloads()).toHaveLength(0);

    await pdfRoute(request("/x"), params(id));
    expect(downloads().map((row) => row.entityId)).toEqual([id]);
  });

  test("[AUD-002] storno nebrání stažení a záznamu", async () => {
    const { owner, customerId } = newOwner();
    const id = issued(owner, customerId);
    cancelInvoice(actor(owner), id);
    session.actor = actor(owner);

    const res = await pdfRoute(request("/x"), params(id));

    expect(res.status).toBe(200);
    expect(await textOf(Buffer.from(await res.arrayBuffer()))).toContain("Stornováno");
  });

  test("[SEC-001] vyčerpaný limit stahování vrátí 429 a náhled dál funguje", async () => {
    const { owner, customerId } = newOwner();
    const { id } = draft(owner, customerId);
    session.actor = actor(owner);
    expect(RATE_RULES.pdfUser).toEqual({ name: "pdfUser", limit: 120, windowSeconds: 60 });

    for (let i = 0; i < RATE_RULES.pdfUser.limit; i++) checkRateLimit(owner, RATE_RULES.pdfUser);

    expect((await pdfRoute(request("/x"), params(id))).status).toBe(429);
    expect((await previewRoute(request("/x"), params(id))).status).toBe(200);
  });

  test("[PDF-009] název souboru bere šablonu z předvoleb", async () => {
    const { owner, customerId } = newOwner();
    savePreferences(actor(owner), { pdfFileName: "FA {cislo}.pdf" });
    const id = issued(owner, customerId);

    const { fileName } = await invoicePdf(owner, id);

    expect(fileName).toMatch(/^FA .+\.pdf$/);
  });
});

describe("rozpočet textu PDF", () => {
  // The longest document the form accepts: 500 lines of ASCII as long as DOCUMENT_INPUT_BYTES lets
  // them be, the four texts in full and the supplier of the fixture.
  // The longest document the form accepts. With 500 lines the JSON keys spend the byte cap first;
  // with fewer, longer lines the printed-text cap binds, which is the worst case for the PDF.
  function longestLines(count = 94) {
    const line = (index: number, size: number) => ({
      catalogItemId: null,
      name: `${index}`.padEnd(200, "n"),
      description: "x".repeat(size),
      quantityMilli: 1000,
      unit: "u".repeat(20),
      unitPriceMinor: 100,
      discountKind: "none" as const,
      discountValue: 0,
    });
    const texts = {
      textBefore: "a".repeat(2000),
      textAfter: "b".repeat(2000),
      note: "c".repeat(2000),
      orderRef: "o".repeat(200),
      reference: "r".repeat(200),
    };
    const of = (n: number) => Array.from({ length: count }, (_, index) => line(index, n));
    const fits = (n: number) =>
      n <= 2_000 &&
      jsonBytes({ lines: of(n), ...texts }) <= DOCUMENT_INPUT_BYTES &&
      printedLength({ lines: of(n), ...texts }) <= PDF_TEXT_BUDGET - DOCUMENT_FRAME_CHARS;
    let size = 1;
    while (fits(size + 1)) size += 1;
    return { lines: of(size), ...texts };
  }

  test(
    "[PDF-005] nejdelší doklad z formuláře se vejde do rozpočtu s rezervou",
    { timeout: 120_000 },
    async () => {
      expect(PDF_TEXT_BUDGET).toBe(200_000);
      // Fewer long lines spend the most printed text; 500 lines spend the most layout.
      for (const count of [94, 500]) {
        const { owner, customerId } = newOwner();
        const { id } = draft(owner, customerId, longestLines(count));
        const doc = loadInvoiceDocument(owner, id)!;
        const length = printedLength(doc);
        expect(length).toBeLessThanOrEqual(PDF_TEXT_BUDGET);
        // Under the budget it really renders, so the form never accepts a document without a PDF.
        const rss = process.memoryUsage().rss;
        const started = performance.now();
        const pdf = await documentPdf(owner, doc);
        expect(pdf.data.subarray(0, 5).toString()).toBe("%PDF-");
        process.stderr.write(
          `[PDF-005] ${count} položek, ${length} znaků: ${Math.round(performance.now() - started)} ms, RSS +${Math.round((process.memoryUsage().rss - rss) / 1048576)} MiB\n`,
        );
        if (count === 94) expect(length).toBeGreaterThan(PDF_TEXT_BUDGET * 0.9);
      }
    },
  );

  test("[PDF-005] doklad nad rozpočet textu se nevykreslí a řekne proč", async () => {
    const { owner, customerId } = newOwner();
    const { id } = draft(owner, customerId, longestLines());
    const doc = loadInvoiceDocument(owner, id)!;
    const over = {
      ...doc,
      lines: doc.lines.map((line) => ({ ...line, description: "y".repeat(3_000) })),
    };
    expect(printedLength(over)).toBeGreaterThan(PDF_TEXT_BUDGET);
    const started = performance.now();
    await expect(documentPdf(owner, over)).rejects.toThrow(PdfTooLong);
    await expect(documentPdf(owner, over)).rejects.toThrow(TEXTS.pdf.tooLong);
    // Refused before react-pdf: a render of that much text takes seconds.
    expect(performance.now() - started).toBeLessThan(1_000);

    // A document from a restore stored that long: the route answers with the reason.
    db.update(invoiceLine)
      .set({ description: "y".repeat(3_000) })
      .where(eq(invoiceLine.invoiceId, id))
      .run();
    session.actor = actor(owner);
    const response = await pdfRoute(request(`/faktury/${id}/pdf`), params(id));
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(TEXTS.pdf.tooLong);
  });
});

describe("náhled designu a rozpočet textu", () => {
  test(
    "[PDF-004] poslední doklad nad rozpočet nahradí v náhledu vzorový doklad",
    { timeout: 60_000 },
    async () => {
      const { owner, customerId } = newOwner();
      const id = issued(owner, customerId);
      // As a restore or an old version could leave it: far more text than any PDF may hold.
      db.update(invoiceLine)
        .set({ description: `DLOUHY${"y".repeat(PDF_TEXT_BUDGET)}` })
        .where(eq(invoiceLine.invoiceId, id))
        .run();
      const started = performance.now();
      const pdf = await designPreviewPdf(owner, { designId: "classic" });
      expect(performance.now() - started).toBeLessThan(20_000);
      const text = await textOf(pdf);
      expect(text).not.toContain("DLOUHY");
    },
  );
});
