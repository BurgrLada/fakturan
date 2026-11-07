import { describe, expect, test } from "vitest";
import { InputRejected, sniffContent } from "@/lib/safe-input/limits";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part)] : part)),
  );

describe("druh obsahu podle bajtů", () => {
  test("[SEC-005] ZIP se pozná podle hlavičky položky i prázdného archivu", () => {
    expect(sniffContent(bytes([0x50, 0x4b, 0x03, 0x04], "x"))).toBe("zip");
    expect(sniffContent(bytes([0x50, 0x4b, 0x05, 0x06], "x"))).toBe("zip");
    expect(sniffContent(bytes([0x50, 0x4b, 0x07, 0x08], "x"))).toBe("text");
  });

  test("[SEC-005] PDF se hledá jen v prvních 1024 bajtech", () => {
    expect(sniffContent(bytes("%PDF-1.7"))).toBe("pdf");
    expect(sniffContent(bytes("x".repeat(1019), "%PDF-"))).toBe("pdf");
    expect(sniffContent(bytes("x".repeat(1020), "%PDF-"))).toBe("text");
    expect(sniffContent(bytes("%PDF"))).toBe("text");
  });

  test("[SEC-005] XML smí začínat BOM a bílými znaky", () => {
    expect(sniffContent(bytes("<a/>"))).toBe("xml");
    expect(sniffContent(bytes(" \t\r\n<a/>"))).toBe("xml");
    expect(sniffContent(bytes([0xef, 0xbb, 0xbf], "\n<a/>"))).toBe("xml");
    expect(sniffContent(bytes("x<a/>"))).toBe("text");
    expect(sniffContent(bytes("   "))).toBe("text");
  });

  test("[SEC-005] UTF-16 s BOM je text, nulový bajt bez něj binární", () => {
    expect(sniffContent(bytes([0xff, 0xfe], "a", [0], "b", [0]))).toBe("text");
    expect(sniffContent(bytes([0xfe, 0xff], [0], "a", [0], "b"))).toBe("text");
    expect(sniffContent(bytes("a", [0], "b"))).toBe("binary");
    expect(sniffContent(bytes("a;b\n1;2\n"))).toBe("text");
  });

  test("[SEC-005] odmítnutí nese kód, položku a podrobnost", () => {
    const error = new InputRejected("zip_corrupt", "a.xml", "hlavička");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "InputRejected",
      code: "zip_corrupt",
      entry: "a.xml",
      message: "zip_corrupt: hlavička",
    });
    expect(new InputRejected("xml_depth").message).toBe("xml_depth");
  });
});
