import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RUN_ENV } from "./process-registry";

// One production build shared by every worker's `next start`.
export default function globalSetup() {
  // Workers and globalTeardown inherit the runner's environment, servers get it from the fixture.
  process.env[RUN_ENV] = randomUUID();
  execFileSync("pnpm", ["exec", "next", "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      BETTER_AUTH_URL: "http://localhost",
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-00",
    },
  });
}
