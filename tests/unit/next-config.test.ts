import { describe, expect, test } from "vitest";
import { MAX_FILE_BYTES } from "@/lib/file-limits";
import nextConfig from "../../next.config";

describe("limit nahrávání", () => {
  test("[SET-014] limit těla server action pojme největší soubor i režii multipartu", () => {
    const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;

    expect(limit).toBe("3mb");
    expect(3 * 1024 * 1024).toBeGreaterThan(MAX_FILE_BYTES + 64 * 1024);
  });
});

describe("cache Next.js", () => {
  test("[ARC-005] cacheMaxMemorySize je v next.config.ts nastavená výslovně a aspoň 50 MB", () => {
    expect(nextConfig.cacheMaxMemorySize).toBeTypeOf("number");
    expect(nextConfig.cacheMaxMemorySize).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  });
});
