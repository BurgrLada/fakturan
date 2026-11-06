import { closeSync, readFileSync } from "node:fs";

// openExport hands over an open descriptor; a test reads it whole and closes it like the route.
export function readOpened(opened: { fd: number }): Uint8Array {
  try {
    return new Uint8Array(readFileSync(opened.fd));
  } finally {
    closeSync(opened.fd);
  }
}
