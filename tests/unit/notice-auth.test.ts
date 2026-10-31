import { describe, expect, test } from "vitest";
import { checkAuthResults } from "@/lib/bank-notices/auth";

const check = (header: string | null) => checkAuthResults(header, "fio.cz");
const results = (...parts: string[]) => ["mx.prijemce.cz", ...parts].join("; ");

describe("Authentication-Results", () => {
  test("[BNK-013] pass jen pro doménu fio.cz, cizí DKIM je fail", () => {
    expect(check(results("dkim=pass header.d=fio.cz header.s=sel"))).toBe("pass");
    expect(check(results("dkim=pass header.d=mail.fio.cz"))).toBe("pass");
    expect(check(results("dkim=pass header.i=@fio.cz"))).toBe("pass");
    expect(check(results("dkim=pass header.i=automat@fio.cz"))).toBe("pass");
    expect(check(results("spf=pass smtp.mailfrom=automat@fio.cz"))).toBe("pass");
    expect(check(results("spf=pass smtp.mailfrom=fio.cz"))).toBe("pass");
    expect(check(results("dmarc=pass header.from=fio.cz"))).toBe("pass");
    expect(check(results("DKIM=PASS Header.D=FIO.CZ"))).toBe("pass");

    expect(check(results("dkim=pass header.d=evil.com"))).toBe("fail");
    expect(check(results("dkim=pass header.d=evilfio.cz"))).toBe("fail");
    expect(check(results("dkim=pass header.d=fio.cz.evil.com"))).toBe("fail");
    expect(check(results("dkim=pass header.i=fio.cz@evil.com"))).toBe("fail");
    expect(check(results("spf=pass smtp.mailfrom=x@evil.com"))).toBe("fail");
    expect(check(results("dmarc=pass header.from=evil.com"))).toBe("fail");
    expect(check(results("dkim=pass"))).toBe("fail");
  });

  test("[BNK-013] kvalifikátor patří metodě, cizí vlastnost se nezapočítá", () => {
    expect(check(results("dkim=pass smtp.mailfrom=fio.cz"))).toBe("fail");
    expect(check(results("spf=pass header.d=fio.cz"))).toBe("fail");
    expect(check(results("dmarc=pass header.d=fio.cz"))).toBe("fail");
    expect(check(results("dkim=fail header.d=fio.cz"))).toBe("fail");
    expect(check(results("arc=pass header.d=fio.cz"))).toBe("none");
    expect(check(results("dkim=pass header.d=fio.cz header.d=evil.com"))).toBe("fail");
  });

  test("[BNK-013] stačí jedna prošlá metoda", () => {
    expect(check(results("spf=fail smtp.mailfrom=x@evil.com", "dkim=pass header.d=fio.cz"))).toBe(
      "pass",
    );
  });

  test("[BNK-013] chybějící výsledek je none", () => {
    expect(check(null)).toBe("none");
    expect(check("")).toBe("none");
    expect(check("mx.prijemce.cz; none")).toBe("none");
    expect(check("mx.prijemce.cz")).toBe("none");
    expect(check(results("dkim=none", "spf=none"))).toBe("none");
  });

  test("[BNK-013] každý jiný výsledek jde do fronty", () => {
    for (const result of ["fail", "softfail", "neutral", "temperror", "permerror"]) {
      expect(check(results(`spf=${result} smtp.mailfrom=fio.cz`))).toBe("fail");
    }
    expect(check(results("dkim=none", "spf=softfail"))).toBe("fail");
  });

  test("[BNK-013] lze číst jen nejvyšší hlavičku, podvržená nižší se neuplatní", () => {
    const spoofedLower = "mx.utocnik.cz; dkim=pass header.d=fio.cz";
    const top = "mx.prijemce.cz; dkim=fail header.d=fio.cz";
    expect(check([top, spoofedLower][0]!)).toBe("fail");
    expect(check(`dkim=pass header.d=fio.cz`)).toBe("none");
  });

  test("[BNK-013] komentář ani řetězec nepodvrhnou výsledek", () => {
    expect(check(results("dkim=fail (dkim=pass header.d=fio.cz) header.d=fio.cz"))).toBe("fail");
    expect(check(results("dkim=fail (; dkim=pass header.d=fio.cz)"))).toBe("fail");
    expect(check(results("dkim=fail (a (b; dkim=pass header.d=fio.cz) c)"))).toBe("fail");
    expect(check(results('spf=fail smtp.mailfrom="; dkim=pass header.d=fio.cz"'))).toBe("fail");
    expect(check(results("dkim=pass (ověřeno) header.d=fio.cz"))).toBe("pass");
    expect(check(results('dkim=pass header.d="fio.cz"'))).toBe("pass");
  });

  test("[BNK-013] nedokončený komentář nebo řetězec je fail", () => {
    expect(check(results("dkim=pass header.d=fio.cz (x"))).toBe("fail");
    expect(check(results('dkim=pass header.d="fio.cz'))).toBe("fail");
    expect(check("mx.prijemce.cz (x; none")).toBe("fail");
  });

  test("[BNK-013] závorka v řetězci a uvozovka v komentáři nic neotevřou", () => {
    expect(check(results('spf=pass smtp.mailfrom="(x"', "dkim=pass header.d=fio.cz"))).toBe("pass");
    expect(check(results('dkim=pass (a"b) header.d=fio.cz'))).toBe("pass");
    expect(check(results("dkim=pass header.d=fio.cz", "x=)"))).toBe("fail");
    expect(check(results("dkim=pass (a (b) c) header.d=fio.cz"))).toBe("pass");
    expect(check(results("dkim=pass (\\() header.d=fio.cz"))).toBe("pass");
    expect(check(results('spf=fail smtp.mailfrom="a\\"; dkim=pass header.d=fio.cz; x=\\"b"'))).toBe(
      "fail",
    );
    expect(check(results('dkim=pass header.s="x header.d=evil.com" header.d=fio.cz'))).toBe("pass");
    expect(check(results("dkim=pass header.d=fio.cz header.d"))).toBe("fail");
    expect(check(results('spf=fail smtp.mailfrom="a\\"; dkim=pass header.d=fio.cz"'))).toBe("fail");
    expect(check(results("dkim=fail (a\\); dkim=pass header.d=fio.cz)"))).toBe("fail");
    expect(check(results('dkim=pass header.d=evil.com header.s="a header.d=fio.cz"'))).toBe("fail");
  });

  test("[BNK-013] přeložená hlavička a doména velkými písmeny", () => {
    expect(check("mx.prijemce.cz;\r\n\tdkim=pass\r\n header.d=fio.cz")).toBe("pass");
    expect(checkAuthResults(results("dkim=pass header.d=fio.cz"), "FIO.CZ")).toBe("pass");
  });
});
