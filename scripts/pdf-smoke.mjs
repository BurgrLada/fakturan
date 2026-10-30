// Runs in the runner image; the Dockerfile bundles scripts/pdf-smoke-entry.ts next to this file.
import { renderFixture } from "./pdf-smoke-bundle.mjs";

const { pdf, hasLogo } = await renderFixture();
if (!hasLogo) throw new Error("Logo SVG se nepřevedlo na PNG");
if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("Výstup není PDF");
console.log(`PDF v pořádku, ${pdf.length} B`);
