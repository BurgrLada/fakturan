import { z } from "zod";
import { auditActionLabel } from "@/lib/audit-labels";
import { isCalendarDate } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { quoted } from "../format";
import { defineTool } from "../tool";
import { AUDIT_SOURCES, entityHistory, listAudit } from "../../services/audit-read";

const T = TEXTS.mcp.insights.audit;
const READ = TEXTS.mcp.read;
const PAGE_SIZE = 50;

type AuditRow = Awaited<ReturnType<typeof entityHistory>>[number];

const date = (description: string) =>
  z
    .string(READ.dateFormat)
    .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value), READ.dateFormat)
    .describe(description);

// The assistant sees what changed and from where, never the network details of the person who did
// it: ip, userAgent and requestId stay in the web's history (spec 5.1).
const row = z.object({
  id: z.number().int(),
  at: z.string(),
  source: z.string(),
  action: z.string(),
  actionLabel: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  clientName: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
});

const toRow = (r: AuditRow): z.infer<typeof row> => ({
  id: r.id,
  at: r.at.toISOString(),
  source: r.source,
  action: r.action,
  actionLabel: auditActionLabel(r.action),
  entity: r.entity,
  entityId: r.entityId,
  clientName: r.clientName,
  before: r.before ?? null,
  after: r.after ?? null,
});

const lines = (rows: z.infer<typeof row>[]) =>
  rows.flatMap((r) => [
    T.row(r.at, r.source, r.actionLabel, r.entity, r.entityId ?? ""),
    ...(r.clientName ? [`  ${quoted(T.client, r.clientName)}`] : []),
    ...(r.before != null ? [`  ${quoted(T.before, JSON.stringify(r.before))}`] : []),
    ...(r.after != null ? [`  ${quoted(T.after, JSON.stringify(r.after))}`] : []),
  ]);

export const listAuditTool = defineTool({
  name: T.list.name,
  title: T.list.title,
  description: T.list.description,
  level: "read",
  input: z.strictObject({
    action: z.string().trim().min(1).max(100).optional().describe(T.list.action),
    entity: z.string().trim().min(1).max(100).optional().describe(T.list.entity),
    source: z.enum(AUDIT_SOURCES).optional().describe(T.list.source),
    actor: z.enum(["self", "other"]).optional().describe(T.list.actor),
    from: date(T.list.from).optional(),
    to: date(T.list.to).optional(),
    page: z.number().int().min(1).optional().describe(T.list.page),
  }),
  output: z.object({
    rows: z.array(row),
    page: z.number().int(),
    hasNext: z.boolean(),
  }),
  fieldLabels: TEXTS.mcp.insights.fields,
  run: (ctx, filter) => {
    const result = listAudit(ctx.actor, { ...filter, pageSize: PAGE_SIZE });
    return { rows: result.rows.map(toRow), page: result.page, hasNext: result.hasNext };
  },
  text: (o) =>
    o.rows.length === 0
      ? T.none
      : [
          T.heading(o.rows.length, o.page),
          ...lines(o.rows),
          ...(o.hasNext ? [T.hasNext] : []),
        ].join("\n"),
});

export const getEntityHistoryTool = defineTool({
  name: T.history.name,
  title: T.history.title,
  description: T.history.description,
  level: "read",
  input: z.strictObject({
    entity: z.string().trim().min(1).max(100).describe(T.history.entity),
    entityId: z.string().trim().min(1).max(100).describe(T.history.entityId),
  }),
  output: z.object({ rows: z.array(row) }),
  fieldLabels: TEXTS.mcp.insights.fields,
  // Another account's record has no rows here, the same answer as a record that never existed.
  run: async (ctx, { entity, entityId }) => ({
    rows: (await entityHistory(ctx.ownerId, entity, entityId)).map(toRow),
  }),
  text: (o) =>
    o.rows.length === 0 ? T.none : [T.historyHeading(o.rows.length), ...lines(o.rows)].join("\n"),
});

export const AUDIT_TOOLS = [listAuditTool, getEntityHistoryTool];
