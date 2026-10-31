import { expect, test } from "vitest";
import {
  extractSpecIds,
  extractTestedIds,
  findMissing,
  findStalePending,
  findUnknownPartial,
  parsePartial,
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

test("[TST-002] spec-partial se čte po řádcích ID, co chybí a plán", () => {
  const source = "# komentář\nA-1\tchybí e-mail\tplán 4\n\nA-2\tchybí banka\tplán 5\n";

  expect(parsePartial(source)).toEqual({
    entries: [
      { id: "A-1", missing: "chybí e-mail", plan: "plán 4" },
      { id: "A-2", missing: "chybí banka", plan: "plán 5" },
    ],
    malformed: [],
  });
});

test("[TST-002] řádek spec-partial bez důvodu nebo plánu je chyba", () => {
  const { entries, malformed } = parsePartial("A-1\tjen důvod\nA-2\t\tplán 4\nA-3\tok\tplán 4\n");

  expect(entries.map((entry) => entry.id)).toEqual(["A-3"]);
  expect(malformed).toEqual(["A-1\tjen důvod", "A-2\t\tplán 4"]);
});

test("[TST-002] ID ve spec-partial musí existovat ve specifikaci", () => {
  const partial = [
    { id: "A-1", missing: "x", plan: "plán 4" },
    { id: "Z-9", missing: "y", plan: "plán 5" },
  ];

  expect(findUnknownPartial({ specIds: ["A-1"], partial })).toEqual(["Z-9"]);
});

test("[TST-002] částečné ID s testem není stale a bez testu dál chybí", () => {
  const specIds = ["A-1", "A-2"];

  expect(findStalePending({ tested: ["A-1"], pending: [] })).toEqual([]);
  expect(findMissing({ specIds, tested: ["A-1"], pending: [] })).toEqual(["A-2"]);
});
