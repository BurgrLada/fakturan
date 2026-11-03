import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { validateIsdoc } from "@/server/isdoc/validate";

const DIR = join("tests", "fixtures", "isdoc");
const encoder = new TextEncoder();
const text = (name: string) => readFileSync(join(DIR, name), "utf8");
const doc = (name: string, xml = text(name)) => ({ name, xml: encoder.encode(xml) });

describe("validace ISDOC proti XSD", () => {
  test("[EXP-005] faktura, záloha, dobropis i cizí měna projdou XSD 6.0.2", async () => {
    const names = readdirSync(DIR).filter((n) => n.endsWith(".isdoc"));
    const results = await validateIsdoc(names.map((n) => doc(n)));
    expect(results.map((r) => r.name)).toEqual(names);
    for (const result of results) expect(result.errors, result.name).toEqual([]);
    const versions = Object.fromEntries(results.map((r) => [r.name, r.version]));
    expect(versions).toMatchObject({
      "faktura-czk.isdoc": "6.0.2",
      "faktura-eur.isdoc": "6.0.2",
      "dobropis.isdoc": "6.0.2",
      "zalohova.isdoc": "6.0.2",
      "verze-601.isdoc": "6.0.1",
    });
  });

  test("[EXP-005] rozbitý doklad vrátí chybu a jmenuje element", async () => {
    const broken = text("faktura-czk.isdoc").replace(/<IssueDate>2026-02-02<\/IssueDate>/, "");
    const wrongType = text("faktura-czk.isdoc").replace("<DocumentType>1<", "<DocumentType>9<");
    const [missing, invalid, fine] = await validateIsdoc([
      doc("a", broken),
      doc("b", wrongType),
      doc("faktura-czk.isdoc"),
    ]);
    expect(missing!.errors.join("\n")).toMatch(/TaxPointDate[\s\S]*not expected[\s\S]*IssueDate/);
    expect(invalid!.errors.join("\n")).toMatch(/DocumentType/);
    expect(fine!.errors).toEqual([]);
  });

  test("[EXP-005] verze se vybírá podle atributu a 5.3 je odmítnutá", async () => {
    // 6.0.2 added a key on line IDs; 6.0.1 has none, so a repeated ID tells the schemas apart.
    const repeated = text("faktura-czk.isdoc").replace(
      "<InvoiceLine><ID>2</ID>",
      "<InvoiceLine><ID>1</ID>",
    );
    const asOld = repeated.replace('version="6.0.2"', 'version="6.0.1"');
    const old = repeated.replace('version="6.0.2"', 'version="5.3"');
    const [newer, older, rejected, none] = await validateIsdoc([
      doc("a", repeated),
      doc("b", asOld),
      doc("c", old),
      doc("d", repeated.replace(' version="6.0.2"', "")),
    ]);
    expect(newer!.errors.join("\n")).toMatch(/InvoiceLines|Duplicate key/);
    expect(older).toEqual({ name: "b", version: "6.0.1", errors: [] });
    expect(rejected).toEqual({
      name: "c",
      version: "5.3",
      errors: ["Verze ISDOC 5.3 není podporovaná, jen 6.0.1 a 6.0.2"],
    });
    expect(none!.errors).toEqual(["Verze ISDOC bez označení není podporovaná, jen 6.0.1 a 6.0.2"]);
  });

  test("[SEC-005] DOCTYPE ani jiný kořen se do xmllint nedostanou", async () => {
    const xxe = text("faktura-czk.isdoc").replace(
      "<Invoice ",
      '<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice ',
    );
    const [entity, other] = await validateIsdoc([doc("x", xxe), doc("y", "<Jine/>")]);
    expect(entity!.errors).toEqual(["Soubor není platné XML (xml_doctype)"]);
    expect(other!.errors).toEqual(["Soubor není faktura ISDOC"]);
  });

  test("[SEC-005] do xmllint jde jen dokument prověřený celý, ne jen kořen", async () => {
    const many = text("faktura-czk.isdoc").replace("<Note>", `${"<Note/>".repeat(200_001)}<Note>`);
    const deep = text("faktura-czk.isdoc").replace(
      "<Note>",
      `<Note>${"<a>".repeat(40)}${"</a>".repeat(40)}`,
    );
    const [nodes, depth] = await validateIsdoc([doc("n", many), doc("d", deep)]);
    expect(nodes!.errors).toEqual(["Soubor není platné XML (xml_nodes)"]);
    expect(depth!.errors).toEqual(["Soubor není platné XML (xml_depth)"]);
  });

  test("dávky po 200 dokladech vrátí výsledek každému", async () => {
    const valid = text("zalohova.isdoc");
    const broken = valid.replace(/<IssueDate>[^<]*<\/IssueDate>/, "");
    const docs = Array.from({ length: 205 }, (_, i) => doc(`d${i}`, i === 203 ? broken : valid));
    const results = await validateIsdoc(docs);
    expect(results).toHaveLength(205);
    expect(results.filter((r) => r.errors.length > 0).map((r) => r.name)).toEqual(["d203"]);
  });

  test("[EXP-005] kontrola obrazu validuje vloženou fixturu a pozná rozbitou", () => {
    const script = readFileSync(join("scripts", "isdoc-smoke.mjs"), "utf8");
    expect(script).toContain(text("faktura-czk.isdoc"));
    const run = spawnSync(process.execPath, [join("scripts", "isdoc-smoke.mjs")], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("ISDOC v pořádku");
  });
});
