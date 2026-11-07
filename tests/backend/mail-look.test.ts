import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MAIL_LAYOUTS } from "@/lib/mail-look";
import { setClockForTests } from "@/server/clock";
import { file, mailLook } from "@/server/db/schema";
import { ServiceError } from "@/server/services/access";
import { FileNotFoundError, openOwnedFile, readOwnedFile } from "@/server/services/files";
import {
  clearMailLogo,
  getMailLook,
  mailLogo,
  mailLookPreview,
  saveMailLook,
  setMailLogo,
} from "@/server/services/mail-look";
import { setSupplierImage } from "@/server/services/supplier";
import { FIXTURE_LOGO_SVG } from "../fixtures/invoices";
import { createTestDb } from "../helpers/db";
import { seedOwner, webActor } from "../helpers/fixtures-mail";

vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-00");
vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "fakturan-mail-look-")));

const db = createTestDb();
const T0 = new Date("2026-11-02T10:00:00Z");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const look = (over: Record<string, unknown> = {}) => ({
  layout: "b2",
  intro: "",
  signature: "",
  logoMode: "supplier",
  ...over,
});

const rowOf = (owner: string) => db.select().from(mailLook).where(eq(mailLook.userId, owner)).get();

beforeEach(() => setClockForTests({ now: () => T0 }));

describe("vzhled e-mailu", () => {
  test("[MAIL-009] bez uložení je vzhled B4 s logem dodavatele", () => {
    const owner = seedOwner(db, T0);

    expect(getMailLook(owner)).toEqual({
      layout: "b4",
      intro: null,
      signature: null,
      logoMode: "supplier",
      logoFileId: null,
    });
  });

  test("[MAIL-010] uloží vzhled, úvod a podpis; prázdný text je null", () => {
    const owner = seedOwner(db, T0);

    saveMailLook(webActor(owner), look({ intro: "Úvod\r\nřádek", signature: "  " }));

    expect(getMailLook(owner)).toMatchObject({
      layout: "b2",
      intro: "Úvod\nřádek",
      signature: null,
    });
  });

  test("[MAIL-010] úvod nad 2 000 znaků a neznámý klíč jsou odmítnuté", () => {
    const owner = seedOwner(db, T0);
    const save = (input: unknown) => () => saveMailLook(webActor(owner), input);

    expect(save(look({ intro: "x".repeat(2_001) }))).toThrow(ServiceError);
    expect(save(look({ signature: "x".repeat(2_001) }))).toThrow(ServiceError);
    expect(save({ ...look(), userId: "cizi" })).toThrow(ServiceError);
    expect(save(look({ layout: "b6" }))).toThrow(ServiceError);
    expect(save(look({ logoMode: "remote" }))).toThrow(ServiceError);
    expect(rowOf(owner)).toBeUndefined();
    saveMailLook(webActor(owner), look({ intro: "x".repeat(2_000) }));
    expect(getMailLook(owner).intro).toHaveLength(2_000);
  });

  test("[SEC-005] SVG logo se sanitizuje a pošle jako PNG", async () => {
    const owner = seedOwner(db, T0);
    const hostile = Buffer.from(
      FIXTURE_LOGO_SVG.toString().replace(
        "</svg>",
        '<script>alert(1)</script><image href="http://x/p.png"/></svg>',
      ),
    );

    setMailLogo(webActor(owner), hostile, "logo.svg");

    const saved = getMailLook(owner);
    expect(saved.logoMode).toBe("custom");
    const stored = readOwnedFile(webActor(owner), saved.logoFileId!);
    expect(stored.kind).toBe("mail_logo");
    expect(stored.data.toString()).not.toMatch(/<script|href="http/);
    const png = await mailLogo(owner, saved);
    expect(png!.subarray(0, 8).equals(PNG)).toBe(true);
    const meta = await sharp(png!).metadata();
    expect(meta.width).toBeLessThanOrEqual(600);
    expect(meta.height).toBeLessThanOrEqual(200);
  });

  test("[MAIL-010] logo e-mailu přebije logo dodavatele, vypnuté logo nedá nic", async () => {
    const owner = seedOwner(db, T0);
    setSupplierImage(webActor(owner), "logo", FIXTURE_LOGO_SVG, "dodavatel.svg");

    const supplierLogo = await mailLogo(owner, getMailLook(owner));
    expect(supplierLogo).not.toBeNull();
    saveMailLook(webActor(owner), look({ logoMode: "none" }));
    expect(await mailLogo(owner, getMailLook(owner))).toBeNull();

    const own = await sharp({
      create: { width: 900, height: 900, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    setMailLogo(webActor(owner), own, "vlastni.png");
    const custom = await mailLogo(owner, getMailLook(owner));
    expect(custom!.equals(supplierLogo!)).toBe(false);
    expect((await sharp(custom!).metadata()).height).toBe(200);

    const first = getMailLook(owner).logoFileId!;
    setMailLogo(webActor(owner), own, "druhe.png");
    expect(db.select().from(file).where(eq(file.id, first)).get()).toBeUndefined();
    clearMailLogo(webActor(owner));
    expect(getMailLook(owner)).toMatchObject({ logoMode: "supplier", logoFileId: null });
    expect(() => clearMailLogo(webActor(owner))).toThrow(ServiceError);
  });

  test("[MAIL-010] vypnuté logo ukáže v hlavičce jméno dodavatele ve všech 7 vzhledech", async () => {
    const owner = seedOwner(db, T0);
    setSupplierImage(webActor(owner), "logo", FIXTURE_LOGO_SVG, "dodavatel.svg");

    for (const layout of MAIL_LAYOUTS) {
      saveMailLook(webActor(owner), look({ layout, logoMode: "supplier" }));
      expect(await mailLookPreview(owner, layout), layout).toMatch(
        /<img[^>]*src="data:image\/png;base64,[^"]+"[^>]*alt="Jan Novák"/,
      );
      saveMailLook(webActor(owner), look({ layout, logoMode: "none" }));
      const html = await mailLookPreview(owner, layout);
      expect(html, layout).not.toMatch(/alt="Jan Novák"/);
      expect(html, layout).toContain("Jan Novák");
      expect(html, layout).not.toMatch(/src="(?!data:)/);
    }
  });

  test("[MAIL-010] náhled ukáže uložený úvod a podpis nad a pod textem", async () => {
    const owner = seedOwner(db, T0);
    saveMailLook(
      webActor(owner),
      look({ layout: "a", intro: "Můj úvod", signature: "Můj podpis" }),
    );

    const html = await mailLookPreview(owner, "a");

    expect(html.indexOf("Můj úvod")).toBeGreaterThan(-1);
    expect(html.indexOf("Můj úvod")).toBeLessThan(html.indexOf("v příloze posílám"));
    expect(html.indexOf("v příloze posílám")).toBeLessThan(html.indexOf("Můj podpis"));
  });

  test("[SEC-002] cizí vzhled ani logo nejde číst ani přepsat", async () => {
    const owner = seedOwner(db, T0);
    const stranger = seedOwner(db, T0);
    saveMailLook(webActor(owner), look({ layout: "c", intro: "Jen můj" }));
    setMailLogo(webActor(owner), FIXTURE_LOGO_SVG, "logo.svg");
    const before = getMailLook(owner);

    expect(getMailLook(stranger)).toMatchObject({ layout: "b4", intro: null, logoFileId: null });
    saveMailLook(webActor(stranger), look({ layout: "a" }));
    expect(() => clearMailLogo(webActor(stranger))).toThrow(ServiceError);
    expect(() => readOwnedFile(webActor(stranger), before.logoFileId!)).toThrow(FileNotFoundError);
    expect(() => openOwnedFile(webActor(stranger), before.logoFileId!)).toThrow(FileNotFoundError);
    expect(
      await mailLogo(stranger, {
        ...getMailLook(stranger),
        logoMode: "custom",
        logoFileId: before.logoFileId,
      }),
    ).toBeNull();
    expect(getMailLook(owner)).toEqual(before);
    expect(getMailLook(stranger).layout).toBe("a");
  });
});
