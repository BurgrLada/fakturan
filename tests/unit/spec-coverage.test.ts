import { expect, test } from "vitest";
import {
  extractSpecIds,
  extractTestedIds,
  findMissing,
  findStalePending,
} from "../../scripts/spec-coverage";

test("[TST-002] nalezne ID bez testu", () => {
  expect(findMissing({ specIds: ["A-1", "A-2"], tested: ["A-1"], pending: [] })).toEqual(["A-2"]);
});

test("[TST-002] ID ve spec-pending nevadí", () => {
  expect(findMissing({ specIds: ["A-1", "A-2"], tested: ["A-1"], pending: ["A-2"] })).toEqual([]);
});

test("[TST-002] ID s testem v pending je chyba", () => {
  expect(findStalePending({ tested: ["A-1"], pending: ["A-1", "A-2"] })).toEqual(["A-1"]);
});

test("[TST-001] ID se čtou ze specifikace a z názvů testů", () => {
  expect(extractSpecIds("- **ZZ-020** a **ZZ-001** a **ZZ-020**")).toEqual(["ZZ-020", "ZZ-001"]);
  expect(extractTestedIds("test('[ZZ-020] x'); test(`[ZZ-001] [ZZ-002] y`)")).toEqual([
    "ZZ-020",
    "ZZ-001",
    "ZZ-002",
  ]);
});
