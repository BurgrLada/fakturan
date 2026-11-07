import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("preset shadcn", () => {
  test("[UI-002] components.json drží preset b5aa4wfToO: base-mira, olive, lucide, default, subtle", () => {
    const config = JSON.parse(readFileSync("components.json", "utf8"));
    expect({
      style: config.style,
      baseColor: config.tailwind?.baseColor,
      iconLibrary: config.iconLibrary,
      menuColor: config.menuColor,
      menuAccent: config.menuAccent,
    }).toEqual({
      style: "base-mira",
      baseColor: "olive",
      iconLibrary: "lucide",
      menuColor: "default",
      menuAccent: "subtle",
    });
  });
});
