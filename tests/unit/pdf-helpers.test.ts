import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test, vi } from "vitest";
import { decodeQr, expectMatchesSnapshot, pdfPagePng, pdfText } from "../helpers/pdf";

function pdfWith(...pages: string[]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const QR = [
  "#######.###.#.#######",
  "#.....#..#..#.#.....#",
  "#.###.#.###.#.#.###.#",
  "#.###.#...#.#.#.###.#",
  "#.###.#...#.#.#.###.#",
  "#.....#.##....#.....#",
  "#######.#.#.#.#######",
  "..........##.........",
  "#.#...##...##..#..#.#",
  "#..###...#...#.###.#.",
  "#.#...#..##......##.#",
  "#...##.#.#..#.#..##..",
  "#..####.#....#.#.#.##",
  "........#.#....#...#.",
  "#######.#######..##..",
  "#.....#..##....#.....",
  "#.###.#...######..##.",
  "#.###.#...#....###...",
  "#.###.#.#####..##.###",
  "#.....#....#..##.##.#",
  "#######.#####..######",
];

function qrPng(quiet = 4, cell = 8): Buffer {
  const size = (QR.length + quiet * 2) * cell;
  const png = new PNG({ width: size, height: size });
  png.data.fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = QR[Math.floor(y / cell) - quiet];
      if (row?.[Math.floor(x / cell) - quiet] === "#")
        png.data.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
  }
  return PNG.sync.write(png);
}

describe("pdf helpers", () => {
  test("[TST-013] pdfText vrátí text po stranách", async () => {
    const pages = await pdfText(pdfWith("Faktura 2026", "Druha strana"));

    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Faktura 2026");
    expect(pages[1]).toContain("Druha strana");
  });

  test("[TST-013] pdfPagePng vykreslí stranu a měřítko mění rozměr", async () => {
    const pdf = pdfWith("Ahoj");
    const small = PNG.sync.read(await pdfPagePng(pdf, 1, 1));
    const large = PNG.sync.read(await pdfPagePng(pdf, 1));

    expect([small.width, small.height]).toEqual([300, 200]);
    expect([large.width, large.height]).toEqual([600, 400]);
    expect(large.data.some((byte, i) => i % 4 === 0 && byte < 128)).toBe(true);
  });

  test("[TST-015] decodeQr přečte QR kód a u obrázku bez kódu vrátí null", () => {
    expect(decodeQr(qrPng())).toBe("SPD*1.0*AM:100.00");

    const blank = new PNG({ width: 40, height: 40 });
    blank.data.fill(255);
    expect(decodeQr(PNG.sync.write(blank))).toBeNull();
  });

  describe("snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "fakturan-snap-"));
    afterAll(() => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });

    test("[TST-008] shodný obrázek projde, výrazně odlišný selže", async () => {
      const png = await pdfPagePng(pdfWith("Snapshot"), 1);
      vi.stubEnv("PDF_SNAPSHOT_DIR", dir);
      expect(() => expectMatchesSnapshot(png, "helper-self-test")).toThrow(/neexistovala/);
      vi.stubEnv("UPDATE_PDF_SNAPSHOTS", "1");
      expectMatchesSnapshot(png, "helper-self-test");
      vi.stubEnv("UPDATE_PDF_SNAPSHOTS", "");

      expect(() => expectMatchesSnapshot(png, "helper-self-test")).not.toThrow();
      const other = await pdfPagePng(pdfWith("Jiny text uplne jinak"), 1);
      expect(() => expectMatchesSnapshot(other, "helper-self-test")).toThrow(/pixelů se liší/);
    });
  });
});
