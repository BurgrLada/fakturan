import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "server-only", replacement: serverOnlyStub },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/backend/**/*.test.ts"],
  },
});
