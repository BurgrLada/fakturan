import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { XML_LIMITS } from "@/lib/safe-input/limits";
import { parseXml } from "@/lib/safe-input/xml";
import { isdocRules } from "@/server/isdoc/rules";

const DIR = join("tests", "fixtures", "isdoc");
const text = (name: string) => readFileSync(join(DIR, name), "utf8");
const rules = (xml: string) => isdocRules(parseXml(new TextEncoder().encode(xml), XML_LIMITS));

describe("pravidla ISDOC mimo schéma", () => {
  test("[EXP-005] všechny fixtury pravidly projdou", () => {
    for (const name of readdirSync(DIR).filter((n) => n.endsWith(".isdoc"))) {
      expect(rules(text(name)), name).toEqual([]);
    }
  });

  test("[EXP-005] dobropis a vrubopis bez odkazu na původní doklad neprojdou", () => {
    for (const name of ["dobropis.isdoc", "vrubopis.isdoc"]) {
      const xml = text(name).replace(
        /<OriginalDocumentReferences>[\s\S]*<\/OriginalDocumentReferences>/,
        "",
      );
      expect(rules(xml)).toEqual([expect.stringMatching(/nemá odkaz na původní doklad/)]);
    }
  });

  test("[EXP-005] cizí měna bez všech částek *Curr neprojde", () => {
    const xml = text("faktura-eur.isdoc").replace(
      /<PayableAmountCurr>[^<]*<\/PayableAmountCurr>/,
      "",
    );
    expect(rules(xml)).toContain("V cizí měně chybí PayableAmountCurr");
    const domestic = text("faktura-czk.isdoc");
    expect(domestic).not.toContain("Curr>");
    expect(rules(domestic)).toEqual([]);
  });

  test("[EXP-005] součty musí sedět a k úhradě nesmí přesáhnout zbytek", () => {
    const czk = text("faktura-czk.isdoc");
    const lineOff = czk.replace(
      "<LineExtensionAmountTaxInclusive>350.50<",
      "<LineExtensionAmountTaxInclusive>352.50<",
    );
    expect(rules(lineOff)).toEqual([
      expect.stringMatching(/^Celek s daní nesedí se součtem řádků: 3350\.50 místo 3352\.50/),
    ]);
    const within = czk.replace(
      "<LineExtensionAmountTaxInclusive>350.50<",
      "<LineExtensionAmountTaxInclusive>351.50<",
    );
    expect(rules(within)).toEqual([]);
    const overPaid = czk.replace(/<PayableAmount>[^<]*</, "<PayableAmount>4000.00<");
    expect(rules(overPaid)).toEqual([expect.stringMatching(/^K úhradě 4000\.00 je mimo rozsah/)]);
    const negative = czk.replace(/<PayableAmount>[^<]*</, "<PayableAmount>-1.00<");
    expect(rules(negative)).toHaveLength(1);
    const recap = czk.replace(/(<TaxSubTotal>[\s\S]*?<TaxInclusiveAmount>)3350\.50/, "$1100.00");
    expect(rules(recap)).toEqual([expect.stringMatching(/rekapitulací daně/)]);
  });

  test("v cizí měně se kontrolují částky dokladu přesně a domácí s tolerancí", () => {
    const eur = text("faktura-eur.isdoc");
    const curr = eur.replace(/<PayableAmountCurr>[^<]*</, "<PayableAmountCurr>500.00<");
    expect(rules(curr)).toEqual([expect.stringMatching(/^K úhradě \(cizí měna\)/)]);
  });

  test("jiný kořen není ISDOC", () => {
    expect(rules("<Invoice/>")).toEqual(["Soubor není faktura ISDOC"]);
  });
});
