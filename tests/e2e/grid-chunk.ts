import type { Page } from "@playwright/test";

// The drag library's own class name, found only in the chunk and the stylesheet that bundle it.
const GRID_MARKER = "react-grid-placeholder";

export function watchGridChunk(
  page: Page,
  type: "script" | "stylesheet" = "script",
): () => boolean {
  let loaded = false;
  page.on("response", async (response) => {
    if (response.request().resourceType() !== type) return;
    const body = await response.text().catch(() => "");
    if (body.includes(GRID_MARKER)) loaded = true;
  });
  return () => loaded;
}
