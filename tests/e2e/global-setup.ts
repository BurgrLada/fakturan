import { execFileSync } from "node:child_process";

// One production build shared by every worker's `next start`.
export default function globalSetup() {
  execFileSync("pnpm", ["exec", "next", "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      BETTER_AUTH_URL: "http://localhost",
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-00",
    },
  });
}
