import { z } from "zod";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { appLink } from "../format";
import { defineTool } from "../tool";
import { getBatch, listBatches } from "../../services/import-batch";
import { undoBatch } from "../../services/import-undo";

const T = TEXTS.mcp.insights.imports;

type Batch = ReturnType<typeof listBatches>[number];

const batch = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  sourceSystem: z.string().nullable(),
  summary: z.record(z.string(), z.number()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
  undoneAt: z.string().nullable(),
  link: z.string(),
});

const toBatch = (baseUrl: string, b: Batch): z.infer<typeof batch> => ({
  id: b.id,
  kind: b.kind,
  status: b.status,
  sourceSystem: b.sourceSystem,
  summary: b.summary,
  error: b.error,
  createdAt: b.createdAt.toISOString(),
  committedAt: b.committedAt?.toISOString() ?? null,
  undoneAt: b.undoneAt?.toISOString() ?? null,
  link: appLink(baseUrl, `/nastaveni/import/${b.id}`),
});

const line = (b: z.infer<typeof batch>) => T.row(b.id, b.kind, b.status, b.createdAt);

// Listed only so that undo_import has an id to take (spec 5.1); importing itself stays in the web.
export const listImportBatchesTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ batches: z.array(batch) }),
  run: (ctx) => ({ batches: listBatches(ctx.ownerId).map((b) => toBatch(ctx.baseUrl, b)) }),
  text: (o) => (o.batches.length === 0 ? T.none : o.batches.map(line).join("\n")),
});

export const undoImportTool = defineTool({
  name: T.undo.name,
  title: T.undo.title,
  description: T.undo.description,
  level: "full",
  input: z.strictObject({ id: z.string().trim().min(1).max(100).describe(T.undo.id) }),
  output: batch,
  run: (ctx, { id }) => {
    undoBatch(ctx.actor, id);
    const after = getBatch(ctx.ownerId, id);
    if (!after) throw new McpToolError(TEXTS.importing.errors.notFound);
    return toBatch(ctx.baseUrl, after);
  },
  text: (o) => [T.undo.done, line(o)].join("\n"),
});

export const IMPORT_TOOLS = [listImportBatchesTool, undoImportTool];
