import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { amountDue, planQr } from "@/lib/qr-payload";
import { qrPng } from "@/server/pdf/qr";
import { decodeQr } from "../helpers/pdf";

const base = {
  currency: "CZK",
  dueMinor: 123450,
  iban: "CZ6508000000192000145399",
  bic: null,
  variableSymbol: "2026001",
  message: "Faktura 2026001",
  recipient: "Acme s.r.o.",
  enabled: true,
  paid: false,
};

function logo(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

const shapes = [
  ["čtvercové", 300, 300],
  ["široké", 600, 120],
  ["vysoké", 120, 600],
] as const;

const worstSpayd = {
  ...base,
  iban: "CZ6508000000192000145399",
  message: "*".repeat(60),
  variableSymbol: "9".repeat(10),
};
const worstEpc = {
  ...base,
  currency: "EUR",
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  recipient: "W".repeat(70),
  message: "M".repeat(200),
};

describe("qrPng", () => {
  test("[QR-004] kód bez loga se dekóduje na stejný obsah a má 1024 px", async () => {
    const plan = planQr(base);
    if (plan.kind === "none") throw new Error("plan");
    const png = await qrPng(plan.payload, null);
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1024]);
    expect(decodeQr(png)).toBe(plan.payload);
  });

  test.each(shapes)("[QR-004] kód s %s logem se dekóduje na stejný obsah", async (_n, w, h) => {
    const plan = planQr(base);
    if (plan.kind === "none") throw new Error("plan");
    const png = await qrPng(plan.payload, await logo(w, h));
    expect(decodeQr(png)).toBe(plan.payload);
  });

  test.each(shapes)(
    "[QR-004] nejhorší délka SPAYD a EPC s %s logem se dekóduje",
    async (_n, w, h) => {
      for (const input of [worstSpayd, worstEpc]) {
        const plan = planQr(input);
        if (plan.kind === "none") throw new Error("plan");
        const png = await qrPng(plan.payload, await logo(w, h));
        expect(decodeQr(png)).toBe(plan.payload);
      }
    },
  );

  test("[QR-004] logo je uprostřed a zabírá nejvýš 20 % strany kódu", async () => {
    const plan = planQr(base);
    if (plan.kind === "none") throw new Error("plan");
    const red = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const { data, info } = await sharp(await qrPng(plan.payload, red))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let [minX, minY, maxX, maxY] = [info.width, info.height, -1, -1];
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) {
          [minX, minY, maxX, maxY] = [
            Math.min(minX, x),
            Math.min(minY, y),
            Math.max(maxX, x),
            Math.max(maxY, y),
          ];
        }
      }
    }
    const side = maxX - minX + 1;
    expect(side).toBe(maxY - minY + 1);
    expect(side).toBeLessThanOrEqual(0.2 * 1024);
    expect(side).toBeGreaterThan(0.1 * 1024);
    expect(Math.abs(minX + maxX + 1 - 1024)).toBeLessThanOrEqual(1);
    expect(Math.abs(minY + maxY + 1 - 1024)).toBeLessThanOrEqual(1);
  });

  test("[QR-004] neplatné logo vyhodí chybu", async () => {
    await expect(qrPng("SPD*1.0", Buffer.from("not an image"))).rejects.toThrow();
  });

  test("[TST-015] dekódovaný QR souhlasí s fakturou", async () => {
    const dueMinor = amountDue({ totalMinor: 123450, paidMinor: 23450 });
    const plan = planQr({ ...base, dueMinor });
    if (plan.kind === "none") throw new Error("plan");
    const decoded = decodeQr(await qrPng(plan.payload, await logo(300, 300)));
    const fields = new Map(
      decoded
        ?.split("*")
        .slice(2)
        .map((part) => [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1)]),
    );
    expect(fields.get("ACC")).toBe(base.iban);
    expect(fields.get("AM")).toBe("1000.00");
    expect(fields.get("CC")).toBe("CZK");
    expect(fields.get("X-VS")).toBe(base.variableSymbol);
    expect(fields.get("MSG")).toBe(base.message);
  });
});
