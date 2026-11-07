import { describe, expect, test } from "vitest";
import { escapeHtml, paragraphs } from "@/server/mail/html/escape";

describe("escapování HTML e-mailu", () => {
  test("[SEC-011] escapeHtml převede & < > \" ' a nic jiného nemění", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b 'c'")).toBe("a &amp; b &#39;c&#39;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    const plain = "Příliš žluťoučký kůň {{cislo}} javascript:x = 1 / 2 · 12 100,00 Kč\t";
    expect(escapeHtml(plain)).toBe(plain);
  });

  test("[SEC-011] paragraphs dělí podle prázdného řádku, uvnitř dá <br> a text escapuje", () => {
    const html = paragraphs("Dobrý den,\r\n\r\nřádek <b>1</b>\nřádek 2\n \n\n\nkonec");

    const texts = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    expect(texts).toEqual(["Dobrý den,", "řádek &lt;b&gt;1&lt;/b&gt;<br>řádek 2", "konec"]);
    expect(html).not.toContain("<b>");
  });

  test("[SEC-011] prázdný text nedá žádný odstavec", () => {
    expect(paragraphs("")).toBe("");
    expect(paragraphs(" \n\n \n")).toBe("");
  });
});
