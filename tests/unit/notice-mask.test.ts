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

  test("[BNK-017] krátký protiúčet se také maskuje a předčíslí nezůstane", () => {
    expect(maskAccount("123456/0800")).toBe("**3456/0800");
    expect(maskAccount("19-2000145399/0800")).toBe("**-******5399/0800");
    expect(maskAccount("1234/0800")).toBe("1234/0800");
    expect(maskAccount("123")).toBe("123");
  });
});
