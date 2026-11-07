import { describe, expect, test } from "vitest";
import { TEXTS } from "@/lib/texts";
import { RestoreRejected } from "@/server/backup/memory-guard";
import { buildIdMap, remapIds } from "@/server/backup/remap";
import type { BackupTable } from "@/server/backup/tables";

const E = TEXTS.restore.errors;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "3333cccc-3333-4333-8333-3333333333cc";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const table = (
  name: string,
  columns: BackupTable["columns"],
  jsonRefs?: BackupTable["jsonRefs"],
): BackupTable => ({ name, table: {} as BackupTable["table"], columns, jsonRefs });

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreRejected);
    return (error as Error).message;
  }
  return "prošlo";
}

describe("přemapování ID při obnově", () => {
  test("[IMP-010] každé ID dostane nové UUID a zdvojené ID archiv odmítne", () => {
    const map = buildIdMap(
      new Map([
        ["customer", [A, B]],
        ["invoice", [C]],
      ]),
    );
    const fresh = [map.tables.get("customer")!.get(A), map.tables.get("customer")!.get(B)];
    expect(fresh.every((id) => UUID.test(id!))).toBe(true);
    expect(new Set([...fresh, map.all.get(C)]).size).toBe(3);
    expect(map.all.get(A)).toBe(fresh[0]);
    expect(map.tables.get("invoice")!.get(C)).toBe(map.all.get(C));
    expect(map.tables.get("invoice")!.has(A)).toBe(false);
    expect(rejection(() => buildIdMap(new Map([["customer", [A, A]]])))).toBe(E.row("customer"));
    expect(
      rejection(() =>
        buildIdMap(
          new Map([
            ["customer", [A]],
            ["invoice", [A]],
          ]),
        ),
      ),
    ).toBe(E.row("invoice"));
  });

  test("[IMP-010] řádek dostane nové ID a odkazy, vlastník a vynechané sloupce zmizí", () => {
    const map = buildIdMap(
      new Map([
        ["customer", [A]],
        ["invoice", [B]],
      ]),
    );
    const invoices = table("invoice", {
      id: "id",
      user_id: "owner",
      customer_id: "ref:customer",
      related_invoice_id: "ref:invoice",
      locked_by: "omit",
      note: "copy",
    });
    const row: Record<string, unknown> = {
      id: B,
      user_id: "cizí",
      customer_id: A,
      related_invoice_id: null,
      locked_by: "x",
      note: `text ${A}`,
      neznamy: 1,
    };
    const result = remapIds(row, invoices, map);
    expect(result).toBe(row);
    const sparse: Record<string, unknown> = { id: B, customer_id: A };
    remapIds(sparse, invoices, map);
    expect(sparse).toEqual({ id: map.all.get(B), customer_id: map.all.get(A) });
    expect(row).toEqual({
      id: map.all.get(B),
      customer_id: map.all.get(A),
      related_invoice_id: null,
      note: `text ${A}`,
    });
  });

  test("[IMP-010] neznámé ID řádku nebo odkazu archiv odmítne", () => {
    const map = buildIdMap(new Map([["customer", [A]]]));
    const customers = table("customer", { id: "id" });
    const invoices = table("invoice", { id: "id", customer_id: "ref:customer" });
    expect(rejection(() => remapIds({ id: UNKNOWN }, customers, map))).toBe(E.row("customer"));
    expect(rejection(() => remapIds({ id: A }, invoices, map))).toBe(E.row("invoice"));
    const withInvoice = buildIdMap(
      new Map([
        ["customer", [A]],
        ["invoice", [B]],
      ]),
    );
    expect(rejection(() => remapIds({ id: B, customer_id: UNKNOWN }, invoices, withInvoice))).toBe(
      E.reference("invoice"),
    );
    expect(rejection(() => remapIds({ id: B, customer_id: B }, invoices, withInvoice))).toBe(
      E.reference("invoice"),
    );
    const orphan = table("invoice", { id: "id", customer_id: "ref:chybi" });
    expect(rejection(() => remapIds({ id: B, customer_id: A }, orphan, withInvoice))).toBe(
      E.reference("invoice"),
    );
  });

  test("[IMP-010] JSON s ID přepíše známá ID v textu, polích i objektech na místě", () => {
    const map = buildIdMap(
      new Map([
        ["customer", [A, C]],
        ["invoice", [B]],
      ]),
    );
    const t = table("dashboard", { layout: "json-ids" });
    const nested = { widget: B, list: [A, { deep: [B, 5] }, null], text: `${A} a ${UNKNOWN}` };
    const layout = [A, nested, `x ${C.toUpperCase()}`, 7];
    const row: Record<string, unknown> = { layout };
    remapIds(row, t, map);
    const a = map.all.get(A)!;
    const b = map.all.get(B)!;
    expect(row.layout).toBe(layout);
    expect(layout[1]).toBe(nested);
    expect(row.layout).toEqual([
      a,
      { widget: b, list: [a, { deep: [b, 5] }, null], text: `${a} a ${UNKNOWN}` },
      `x ${map.all.get(C)}`,
      7,
    ]);
    const plain: Record<string, unknown> = { layout: A };
    remapIds(plain, t, map);
    expect(plain.layout).toBe(a);
  });

  test("[IMP-010] položky JSON s odkazem na tabulku musí v archivu existovat", () => {
    const map = buildIdMap(
      new Map([
        ["file", [A]],
        ["email_log", [B]],
      ]),
    );
    const t = table(
      "email_log",
      { id: "id", html_images: "json-ids" },
      {
        html_images: { table: "file", key: "fileId" },
      },
    );
    const row: Record<string, unknown> = { id: B, html_images: [{ cid: "qr", fileId: A }] };
    remapIds(row, t, map);
    expect(row.html_images).toEqual([{ cid: "qr", fileId: map.all.get(A) }]);
    expect(
      rejection(() => remapIds({ id: B, html_images: [{ cid: "qr", fileId: B }] }, t, map)),
    ).toBe(E.reference("email_log"));
    const none = buildIdMap(new Map([["email_log", [B]]]));
    expect(
      rejection(() => remapIds({ id: B, html_images: [{ cid: "qr", fileId: A }] }, t, none)),
    ).toBe(E.reference("email_log"));
    const empty: Record<string, unknown> = { id: B, html_images: null };
    remapIds(empty, t, map);
    expect(empty.html_images).toBeNull();
  });

  test("[IMP-010] klíč __proto__ z JSON se přepíše jako data, prototyp zůstane", () => {
    const map = buildIdMap(new Map([["customer", [A]]]));
    const t = table("dashboard", { layout: "json-ids" });
    const layout = JSON.parse(`{"__proto__": {"polluted": "${A}"}, "x": "${A}"}`);
    remapIds({ layout }, t, map);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(layout, "__proto__")!.value).toEqual({
      polluted: map.all.get(A),
    });
    expect(layout.x).toBe(map.all.get(A));
  });
});
