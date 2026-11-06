import type { Page } from "@playwright/test";

// The drag library's own class name, found only in the chunk and the stylesheet that bundle it.
const GRID_MARKER = "react-grid-placeholder";

// Resolves once every body seen so far has been read, so a "not loaded" answer cannot come from a
// response whose text simply had not arrived yet.
export function watchGridChunk(
  page: Page,
  type: "script" | "stylesheet" = "script",
): () => Promise<boolean> {
  let loaded = false;
  const pending = new Set<Promise<void>>();
  page.on("response", (response) => {
    if (response.request().resourceType() !== type) return;
    const read = response
      .text()
      .catch(() => "")
      .then((body) => {
        if (body.includes(GRID_MARKER)) loaded = true;
      });
    pending.add(read);
    void read.finally(() => pending.delete(read));
  });
  return async () => {
    await Promise.all(pending);
    return loaded;
  };
}
