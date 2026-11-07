import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { readableOn } from "@/lib/contrast";
import type { InvoiceDocument } from "@/lib/invoice-document";
import { TEXTS } from "@/lib/texts";
import {
  DEFAULT_MAIL_LAYOUT,
  LAYOUTS_WITH_QR,
  MAIL_LAYOUTS,
  type MailLayout,
} from "@/server/mail/html/layouts";
import {
  emailAccent,
  emailSummary,
  renderEmailHtml,
  type EmailHtmlInput,
} from "@/server/mail/html/render";
import { NEUTRAL_BAND } from "@/server/mail/html/tokens";
import { getDesign } from "@/server/pdf/designs";
import { buildInvoiceView, documentQrPng, documentTitle } from "@/server/pdf/view";
import { INVOICE_FIXTURES } from "../fixtures/invoices";
import { decodeQr } from "../helpers/pdf";

const F = INVOICE_FIXTURES;
const noImage = () => null;

let fakeQr: Buffer;
let fakeLogo: Buffer;

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();
}

async function images() {
  fakeQr ??= await png(64, 64);
  fakeLogo ??= await png(300, 100);
  return { qr: fakeQr, logo: fakeLogo };
}

function input(over: Partial<EmailHtmlInput> = {}): EmailHtmlInput {
  return {
    layout: "b4",
    kind: "invoice",
    language: "cs",
    body: "Dobrý den,\n\nposíláme fakturu za říjen.",
    intro: null,
    signature: null,
    supplierName: "Studio Příklad",
    supplierIco: "12345678",
    logo: null,
    accent: null,
    attachment: "2026-040.pdf",
    summary: {
      title: "Faktura 2026-040",
      number: "2026-040",
      amountDue: 1_210_000,
      currency: "CZK",
      dueDate: "14. 11. 2026",
      variableSymbol: "2026040",
      account: "123456789/0800",
    },
    qr: null,
    ...over,
  };
}

const srcs = (html: string) => [...html.matchAll(/\bsrc="([^"]*)"/g)].map((m) => m[1]);
const hasQr = (out: ReturnType<typeof renderEmailHtml>) =>
  out.html.includes("cid:qr@fakturan") || out.images.some((image) => image.cid === "qr@fakturan");

describe("HTML e-mail", () => {
  test("[SEC-011] jméno, číslo, úvod, podpis a text s </td> se v HTML neobjeví jako značka", async () => {
    const hostile = "<b>\"Zlý\"</b> & 'syn' </td><script>alert(1)</script>";
    for (const layout of MAIL_LAYOUTS) {
      const { html } = renderEmailHtml(
        input({
          layout,
          supplierName: hostile,
          supplierIco: "</td>1",
          body: `Text ${hostile}\n\n{{cislo_faktury}} javascript:alert(1)`,
          intro: `Úvod ${hostile}`,
          signature: `<img src=x onerror=alert(1)>`,
          attachment: "</td>.pdf",
          summary: {
            ...input().summary!,
            title: hostile,
            number: "</td><td>",
            variableSymbol: "<i>",
            account: '"><svg onload=1>',
            dueDate: "<u>",
          },
        }),
      );

      expect(html, layout).not.toMatch(/<script|<b>|<img src=x|<svg|<i>|<u>|<td><\/td><td>/);
      expect(html, layout).not.toContain("</td><script>");
      expect(html, layout).toContain("&lt;b&gt;&quot;Zlý&quot;&lt;/b&gt; &amp; &#39;syn&#39;");
      expect(html, layout).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html, layout).toContain("{{cislo_faktury}} javascript:alert(1)");
      expect(html, layout).not.toMatch(/href=/);
    }
  });

  test("[MAIL-007] každé src v HTML začíná cid: a v HTML není http(s):// mimo text zprávy", async () => {
    const { qr, logo } = await images();
    for (const layout of MAIL_LAYOUTS) {
      const out = renderEmailHtml(
        input({ layout, logo, qr, body: "Platit lze i na https://banka.example/platba." }),
      );

      expect(srcs(out.html).length, layout).toBeGreaterThan(0);
      for (const src of srcs(out.html)) expect(src, layout).toMatch(/^cid:/);
      expect(out.html.match(/https?:\/\//g), layout).toEqual(["https://"]);
      expect(out.html, layout).not.toMatch(/<a\b|<link|<script|<style|@import|url\(|<form/i);
      for (const image of out.images) {
        expect(out.html, layout).toContain(`cid:${image.cid}`);
      }
    }
  });

  test("[MAIL-009] všech 7 vzhledů dá HTML s tabulkou šířky 600 a bez slova Fakturan", async () => {
    const { qr, logo } = await images();
    expect([...MAIL_LAYOUTS]).toEqual(["b1", "b2", "b3", "b4", "b5", "a", "c"]);
    expect(DEFAULT_MAIL_LAYOUT).toBe("b4");
    for (const layout of MAIL_LAYOUTS) {
      for (const extra of [{}, { logo, qr }]) {
        const { html } = renderEmailHtml(input({ layout, ...extra }));

        expect(html, layout).toMatch(/^<!DOCTYPE html>/);
        expect(html, layout).toMatch(/<table[^>]*\bwidth="600"/);
        expect(html, layout).not.toContain("Fakturan");
        expect(html, layout).not.toContain("Doporučuju");
        expect(html, layout).toContain("posíláme fakturu za říjen.");
        expect(html, layout).toContain("12&nbsp;100,00&nbsp;Kč");
      }
    }
  });

  test("[MAIL-009] B4 s akcentem #2f5d62 má pás #2f5d62 a text #ffffff", () => {
    const { html } = renderEmailHtml(input({ accent: "#2f5d62" }));

    expect(html).toContain('bgcolor="#2f5d62"');
    expect(html).toContain("background-color:#2f5d62;color:#ffffff");
  });

  test("[MAIL-009] B4 s akcentem #f5d000 má text #000000", () => {
    const { html } = renderEmailHtml(input({ accent: "#f5d000" }));

    expect(html).toContain("background-color:#f5d000;color:#000000");
  });

  test("[MAIL-009] bez platného akcentu je pás NEUTRAL_BAND", () => {
    const band = `background-color:${NEUTRAL_BAND};color:${readableOn(NEUTRAL_BAND)}`;
    for (const accent of [null, "red", "#12345", "#2f5d62;x"]) {
      const { html } = renderEmailHtml(input({ accent }));

      expect(html, String(accent)).toContain(band);
      expect(html, String(accent)).not.toContain("red;");
    }
  });

  test("[MAIL-009] C bere akcent do linky, B1 zůstává neutrální", () => {
    const line = renderEmailHtml(input({ layout: "c", accent: "#2f5d62" })).html;
    const neutralLine = renderEmailHtml(input({ layout: "c", accent: null })).html;

    expect(line).toMatch(/<td[^>]*height="3"[^>]*bgcolor="#2f5d62"/);
    expect(neutralLine).toMatch(new RegExp(`<td[^>]*height="3"[^>]*bgcolor="${NEUTRAL_BAND}"`));
    for (const layout of ["b1", "b2", "b3", "b5", "a"] as const) {
      expect(renderEmailHtml(input({ layout, accent: "#2f5d62" })).html, layout).not.toContain(
        "2f5d62",
      );
    }
  });

  test("[MAIL-009] akcent je vlastní barva dokladu, jinak akcent designu", () => {
    const own = {
      ...F.short.appearance,
      colors: { ...F.short.appearance.colors, accent: "#2f5d62" },
    };
    const invalid = { ...own, colors: { ...own.colors, accent: "zelená" } };

    expect(emailAccent({ ...F.short, appearance: own })).toBe("#2f5d62");
    expect(emailAccent({ ...F.short, appearance: invalid })).toBe(
      getDesign(F.short.appearance.designId).tokens.colors.accent,
    );
  });

  test("[MAIL-009] pořadí bloků odpovídá návrhu", async () => {
    const { qr } = await images();
    const at = (html: string, needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const body = "posíláme fakturu za říjen.";
    const amount = "12&nbsp;100,00&nbsp;Kč";
    const qrSrc = "cid:qr@fakturan";

    const b1 = renderEmailHtml(input({ layout: "b1" })).html;
    expect(at(b1, body)).toBeLessThan(at(b1, amount));
    expect(at(b1, amount)).toBeLessThan(at(b1, "Příloha: 2026-040.pdf"));

    const b2 = renderEmailHtml(input({ layout: "b2", qr })).html;
    expect(at(b2, body)).toBeLessThan(at(b2, amount));
    expect(at(b2, amount)).toBeLessThan(at(b2, qrSrc));
    expect(at(b2, qrSrc)).toBeLessThan(at(b2, "Variabilní symbol"));

    const b3 = renderEmailHtml(input({ layout: "b3", qr })).html;
    expect(at(b3, body)).toBeLessThan(at(b3, "K úhradě do 14. 11. 2026"));
    expect(at(b3, amount)).toBeLessThan(at(b3, qrSrc));
    expect(at(b3, qrSrc)).toBeLessThan(at(b3, TEXTS.mailHtml.cs.scanHint));

    const b4 = renderEmailHtml(input({ layout: "b4" })).html;
    expect(at(b4, "Faktura 2026-040")).toBeLessThan(at(b4, body));
    expect(at(b4, body)).toBeLessThan(at(b4, amount));

    const b5 = renderEmailHtml(input({ layout: "b5", qr })).html;
    expect(at(b5, "Faktura 2026-040")).toBeLessThan(at(b5, amount));
    expect(at(b5, amount)).toBeLessThan(at(b5, qrSrc));
    expect(at(b5, qrSrc)).toBeLessThan(at(b5, body));

    for (const layout of ["a", "c"] as const) {
      const letter = renderEmailHtml(input({ layout, signature: "Jana Příkladová" })).html;
      expect(at(letter, body)).toBeLessThan(at(letter, "Číslo dokladu"));
      expect(at(letter, amount)).toBeLessThan(at(letter, "Jana Příkladová"));
    }
  });

  test("[MAIL-009] úvod je nad textem, podpis pod ním a anglická faktura má anglické popisky", () => {
    const { html } = renderEmailHtml(
      input({ language: "en", intro: "Úvodní věta", signature: "Podpis" }),
    );

    expect(html.indexOf("Úvodní věta")).toBeLessThan(html.indexOf("posíláme"));
    expect(html.indexOf("posíláme")).toBeLessThan(html.indexOf("Podpis"));
    expect(html).toContain(TEXTS.mailHtml.en.due);
    expect(html).not.toContain(TEXTS.mailHtml.cs.due);
    expect(html).toContain('lang="en"');
  });

  test("[MAIL-009] logo jde jako cid:logo@fakturan, bez loga je v hlavičce jméno dodavatele", async () => {
    const { logo } = await images();
    for (const layout of MAIL_LAYOUTS) {
      const withLogo = renderEmailHtml(input({ layout, logo }));
      const without = renderEmailHtml(input({ layout, supplierName: "Ateliér Nový" }));

      expect(withLogo.images.find((image) => image.cid === "logo@fakturan")?.png).toBe(logo);
      expect(withLogo.html, layout).toMatch(
        /<img[^>]*src="cid:logo@fakturan"[^>]*alt="Studio Příklad"/,
      );
      expect(without.images, layout).toEqual([]);
      expect(without.html, layout).toContain("Ateliér Nový");
    }
  });

  test("[MAIL-009] logo v pásu B4 leží na světlé destičce", async () => {
    const { logo } = await images();
    const { html } = renderEmailHtml(input({ logo, accent: "#111111" }));

    expect(html).toMatch(
      /<td bgcolor="#ffffff" style="background-color:#ffffff;padding:[^"]*"><img[^>]*src="cid:logo@fakturan"/,
    );
  });

  test("[TST-015] QR z cid:qr@fakturan dekóduje stejný payload jako QR v PDF", async () => {
    for (const doc of [F.short, F.eur]) {
      const view = await buildInvoiceView(doc, {
        today: "2026-03-10",
        draft: false,
        readImage: noImage,
      });
      const qr = await documentQrPng(doc, documentTitle(doc, false), noImage);

      for (const layout of LAYOUTS_WITH_QR) {
        const out = renderEmailHtml(
          input({ layout, summary: emailSummary(doc), qr: qr!.png, language: doc.language }),
        );
        const image = out.images.find((entry) => entry.cid === "qr@fakturan");

        expect(decodeQr(image!.png)).toBe(qr!.payload);
        expect(decodeQr(image!.png)).toBe(decodeQr(view.payment.qr!));
      }
    }
  });

  test("[MAIL-009] B1, B4, A, C a potvrzení platby QR nemají ani při dluhu", async () => {
    const { qr } = await images();
    for (const layout of ["b1", "b4", "a", "c"] as MailLayout[]) {
      expect(hasQr(renderEmailHtml(input({ layout, qr }))), layout).toBe(false);
    }
    for (const layout of LAYOUTS_WITH_QR) {
      expect(hasQr(renderEmailHtml(input({ layout, qr }))), layout).toBe(true);
      expect(hasQr(renderEmailHtml(input({ layout, qr, kind: "reminder" }))), layout).toBe(true);
      expect(hasQr(renderEmailHtml(input({ layout, qr, kind: "payment_receipt" }))), layout).toBe(
        false,
      );
      expect(hasQr(renderEmailHtml(input({ layout, qr, kind: "credit_note" }))), layout).toBe(
        false,
      );
    }
  });

  test("[MAIL-009] koncept ani uhrazená faktura QR nemají", async () => {
    const draft: InvoiceDocument = { ...F.short, status: "draft", number: null };
    const paid: InvoiceDocument = { ...F.short, status: "paid" };

    expect(await documentQrPng(draft, documentTitle(draft, true), noImage)).toBeNull();
    expect(await documentQrPng(paid, documentTitle(paid, false), noImage)).toBeNull();
    const settled = { ...emailSummary(F.short), amountDue: 0 };
    const { qr } = await images();
    for (const layout of LAYOUTS_WITH_QR) {
      const out = renderEmailHtml(input({ layout, qr, summary: settled }));
      expect(hasQr(out), layout).toBe(false);
      expect(out.html, layout).toContain(TEXTS.mailHtml.cs.paid);
    }
  });

  test("[MAIL-009] souhrn dokladu nese zbývající částku, splatnost, VS a účet", () => {
    const summary = emailSummary({
      ...F.short,
      status: "partially_paid",
      totals: { ...F.short.totals, paidMinor: 100_000 },
    });

    expect(summary.amountDue).toBe(F.short.totals.totalMinor - 100_000);
    expect(summary.title).toBe(`Faktura ${F.short.number}`);
    expect(summary.variableSymbol).toBe(F.short.variableSymbol);
    expect(summary.account).toBe(
      `${F.short.snapshot.account!.number}/${F.short.snapshot.account!.bankCode}`,
    );
    expect(emailSummary({ ...F.short, paymentMethod: "cash" }).account).toBeNull();
  });
});
