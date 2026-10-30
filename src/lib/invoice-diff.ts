import type { DocumentLine, InvoiceDocument } from "./invoice-document";

export type LineRow = DocumentLine & { position: number };
type LineBody = ReturnType<typeof lineBody>;

export function lineBody(line: LineRow) {
  return {
    position: line.position,
    catalogItemId: line.catalogItemId,
    name: line.name,
    description: line.description,
    quantityMilli: line.quantityMilli,
    unit: line.unit,
    unitPriceMinor: line.unitPriceMinor,
    discountKind: line.discountKind,
    discountValue: line.discountValue,
    netMinor: line.netMinor,
  };
}

function contentKey(line: LineRow): string {
  return JSON.stringify({ ...lineBody(line), position: 0 });
}

type LinePair = { from: LineRow; to: LineRow };
type PairedLines = {
  edits: LinePair[];
  moves: LinePair[];
  removed: LineRow[];
  added: LineRow[];
};

// Lines are replaced on every save, so ids cannot pair them: identical content pairs first (a
// move), then what is left at the same position (an edit).
function pairLines(before: LineRow[], after: LineRow[]): PairedLines | null {
  const unchanged = (line: LineRow, i: number, other: LineRow[]) =>
    other[i] !== undefined && contentKey(other[i]) === contentKey(line);
  const left = before.filter((line, i) => !unchanged(line, i, after));
  const right = after.filter((line, i) => !unchanged(line, i, before));
  if (left.length === 0 && right.length === 0) return null;

  const waiting = new Map<string, LineRow[]>();
  for (const line of left) {
    waiting.set(contentKey(line), [...(waiting.get(contentKey(line)) ?? []), line]);
  }
  const moves: LinePair[] = [];
  const unpairedRight = right.filter((to) => {
    const from = waiting.get(contentKey(to))?.shift();
    if (from) moves.push({ from, to });
    return !from;
  });
  const unpairedLeft = [...waiting.values()].flat().sort((a, b) => a.position - b.position);

  const atPosition = new Map(unpairedRight.map((line) => [line.position, line]));
  const edits = unpairedLeft.flatMap((from) => {
    const to = atPosition.get(from.position);
    return to ? [{ from, to }] : [];
  });
  const edited = new Set(edits.map((pair) => pair.from.position));
  return {
    edits,
    moves,
    removed: unpairedLeft.filter((line) => !edited.has(line.position)),
    added: unpairedRight.filter((line) => !edited.has(line.position)),
  };
}

type LineChanges = {
  before: {
    changed: LineBody[];
    removed: LineBody[];
    moved: { name: string; position: number }[];
  };
  after: {
    changed: LineBody[];
    added: LineBody[];
    moved: { name: string; position: number }[];
  };
};

// Only the difference goes to the audit, because autosave would otherwise copy up to 500 lines per
// pause in typing.
export function diffLines(before: LineRow[], after: LineRow[]): LineChanges | null {
  const paired = pairLines(before, after);
  if (!paired) return null;
  const moved = (side: "from" | "to") =>
    paired.moves.map((move) => ({
      name: move[side].name,
      position: move[side].position,
    }));
  return {
    before: {
      changed: paired.edits.map((pair) => lineBody(pair.from)),
      removed: paired.removed.map(lineBody),
      moved: moved("from"),
    },
    after: {
      changed: paired.edits.map((pair) => lineBody(pair.to)),
      added: paired.added.map(lineBody),
      moved: moved("to"),
    },
  };
}

type FieldValue = string | number | boolean | null;

export type InvoiceChange =
  | { kind: "field"; field: string; before: FieldValue; after: FieldValue }
  | {
      kind: "line";
      change: "changed" | "added" | "removed" | "moved";
      position: number;
      before: LineBody | null;
      after: LineBody | null;
    };

// Flattened to leaves, so nested objects compare regardless of key order and a missing snapshot
// shows field by field.
function flatten(value: object, prefix = ""): [string, FieldValue][] {
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === "object" && item !== null
      ? flatten(item, `${prefix}${key}.`)
      : [[`${prefix}${key}`, item as FieldValue]],
  );
}

// Status and payments move on their own, a version compares what the document says.
function documentFields(document: InvoiceDocument): Map<string, FieldValue> {
  const { id: _i, status: _s, lines: _l, totals, ...rest } = document;
  const { paidMinor: _p, ...sums } = totals;
  return new Map(flatten({ ...rest, totals: sums }));
}

const withPositions = (document: InvoiceDocument): LineRow[] =>
  document.lines.map((line, position) => ({ ...line, position }));

export function diffInvoices(a: InvoiceDocument, b: InvoiceDocument): InvoiceChange[] {
  const left = documentFields(a);
  const right = documentFields(b);
  const fields = [...new Set([...left.keys(), ...right.keys()])].flatMap((field) => {
    const before = left.get(field) ?? null;
    const after = right.get(field) ?? null;
    return before === after ? [] : [{ kind: "field" as const, field, before, after }];
  });

  const paired = pairLines(withPositions(a), withPositions(b));
  if (!paired) return fields;
  const pair = (change: "changed" | "moved") => (lines: LinePair) => ({
    kind: "line" as const,
    change,
    position: lines.to.position,
    before: lineBody(lines.from),
    after: lineBody(lines.to),
  });
  return [
    ...fields,
    ...paired.edits.map(pair("changed")),
    ...paired.moves.map(pair("moved")),
    ...paired.removed.map((line) => ({
      kind: "line" as const,
      change: "removed" as const,
      position: line.position,
      before: lineBody(line),
      after: null,
    })),
    ...paired.added.map((line) => ({
      kind: "line" as const,
      change: "added" as const,
      position: line.position,
      before: null,
      after: lineBody(line),
    })),
  ];
}
