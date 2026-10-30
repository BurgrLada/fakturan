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
