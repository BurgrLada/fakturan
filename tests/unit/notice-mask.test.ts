import { describe, expect, test } from "vitest";
import { maskAccount, maskDigits } from "@/lib/bank-notices/mask";

describe("maskování", () => {
  test("[BNK-017] maskování nechá poslední 4 číslice", () => {
    expect(maskDigits("účet 1234567 a 123456 a 12345678901")).toBe(
      "účet ***4567 a 123456 a *******8901",
    );
    expect(maskAccount("1234567890/0800")).toBe("******7890/0800");
    expect(maskAccount("1234567890")).toBe("******7890");
  });

  test("[BNK-017] text skryje krátký účet s kódem banky i s předčíslím", () => {
    expect(maskDigits("z účtu 123456/0800 došlo")).toBe("z účtu **3456/0800 došlo");
    expect(maskDigits("z účtu 19-123456/0800")).toBe("z účtu **-**3456/0800");
    expect(maskDigits("x 1234/0800")).toBe("x 1234/0800");
  });

  test("[BNK-017] text skryje IBAN po skupinách i vcelku", () => {
    expect(maskDigits("IBAN CZ00 1111 2222 3333 4444 5555 hotovo")).toBe(
      "IBAN CZ** **** **** **** **** 5555 hotovo",
    );
    expect(maskDigits("CZ00\u00A01111\u00A02222\u00A03333")).toBe(
      "CZ**\u00A0****\u00A0****\u00A03333",
    );
    expect(maskDigits("CZ00111122223333444455")).toBe("CZ****************4455");
    expect(maskDigits("DE00 1111 2222 3333 4444 55")).toBe("DE** **** **** **** **44 55");
  });

  test("[BNK-017] IBAN skryje i malými písmeny a s jiným oddělovačem", () => {
    expect(maskDigits("iban cz00 1111 2222 3333 4444 5555")).toBe(
      "iban cz** **** **** **** **** 5555",
    );
    expect(maskDigits("Cz00-1111-2222-3333-4444-5555")).toBe("Cz**-****-****-****-****-5555");
    expect(maskDigits("CZ00.1111.2222.3333.4444.5555")).toBe("CZ**.****.****.****.****.5555");
    expect(maskDigits("cz00111122223333444455")).toBe("cz****************4455");
  });

  test("[BNK-017] předčíslí bez kódu banky se skryje", () => {
    expect(maskDigits("z účtu 19-123456 došlo")).toBe("z účtu **-**3456 došlo");
    expect(maskDigits("19-2000145399")).toBe("**-******5399");
  });

  test("[BNK-017] datum s pomlčkami a telefon nejsou předčíslí", () => {
    expect(maskDigits("2026-10-30 a 30-10-2026 a 777-123-456")).toBe(
      "2026-10-30 a 30-10-2026 a 777-123-456",
    );
  });

  test("[BNK-017] datum a částka zůstanou čitelné", () => {
    expect(maskDigits("10/30/2026 30.10.2026 1 234,50")).toBe("10/30/2026 30.10.2026 1 234,50");
  });

  test("[BNK-017] krátký protiúčet se také maskuje a předčíslí nezůstane", () => {
    expect(maskAccount("123456/0800")).toBe("**3456/0800");
    expect(maskAccount("19-1234567890/0800")).toBe("**-******7890/0800");
    expect(maskAccount("1234/0800")).toBe("1234/0800");
    expect(maskAccount("123")).toBe("123");
  });
});
