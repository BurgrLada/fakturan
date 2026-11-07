import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";
import base from "./vitest.config";

// scripts/mutation.ts passes the mapped test files: a static mutant reruns every included test, and
// Stryker's related-file lookup finds none in its sandbox, so without this list nothing would run.
const files = (process.env.MUTATION_TEST_FILES ?? "").split(",").filter(Boolean);
if (files.length === 0) throw new Error("MUTATION_TEST_FILES is empty");

const projects = (base.test?.projects ?? []) as TestProjectInlineConfiguration[];

export default defineConfig({
  test: {
    projects: projects.flatMap((project) => {
      const include = files.filter((file) => file.startsWith(`tests/${project.test?.name}/`));
      // Instrumented code runs several times slower; Stryker's own per-mutant timeout still applies.
      const testTimeout = Math.max(project.test?.testTimeout ?? 0, 60_000);
      return include.length > 0
        ? [{ ...project, test: { ...project.test, include, testTimeout } }]
        : [];
    }),
  },
});
