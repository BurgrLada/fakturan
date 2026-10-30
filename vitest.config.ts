import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url));

const resolve = {
  alias: [
    { find: "server-only", replacement: serverOnlyStub },
    { find: /^@\//, replacement: `${src}/` },
  ],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        resolve,
        test: { name: "backend", include: ["tests/backend/**/*.test.ts"] },
      },
    ],
  },
});
