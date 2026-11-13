import { z } from "zod";
import { AUTOMATION_KEYS, type AutomationSettings } from "@/lib/automation";
import { MESSAGE_KINDS } from "@/lib/email-template";
import { formatRate, parseRate } from "@/lib/invoice-form";
import { parseMoney } from "@/lib/money";
import { PERIOD_SUMMARIES } from "@/lib/owner-reports";
import { LANGUAGES, type Preferences } from "@/lib/preferences";
import type { ReminderRule } from "@/lib/reminders";
import { TEXTS } from "@/lib/texts";
import { McpToolError } from "../errors";
import { money, moneySchema, quoted } from "../format";
import { defineTool, type ToolContext } from "../tool";
import {
  getAutomation,
  setAutomation,
  setDailyDigest,
  setLimitMail,
  setPaused,
  setPeriodSummary,
  setSendTime,
  setTaxReminder,
} from "../../services/automation";
import {
  getEmailTemplate,
  listEmailTemplates,
  resetEmailTemplateAndRead,
  saveEmailTemplate,
} from "../../services/email-templates";
import {
  getPreferences,
  preferencesPatchSchema,
  preferencesSchema,
  savePreferences,
  type PreferencesPatch,
} from "../../services/preferences";
import { deleteReminderRule, listReminderRules, saveReminderRule } from "../../services/reminders";
import {
  getSupplier,
  missingSupplierFields,
  saveSupplier,
  type SupplierInput,
} from "../../services/supplier";

const T = TEXTS.mcp.config;

const id = (description: string) => z.string().min(1).max(100).describe(description);

// ---------------------------------------------------------------------------------------------
// Supplier. Images (logo, QR logo, signature) stay web-only: they are uploads, not fields.

const SUPPLIER_TEXT = {
  name: 200,
  street: 200,
  city: 100,
  zip: 20,
  country: 100,
  ico: 20,
  dic: 20,
  email: 254,
  phone: 40,
  web: 200,
  registryNote: 500,
  contactPerson: 200,
  footerText: 1000,
  notVatPayerCs: 300,
  notVatPayerEn: 300,
  reverseChargeCs: 300,
  reverseChargeEn: 300,
  advanceNoteCs: 300,
  advanceNoteEn: 300,
} as const;
type SupplierTextKey = keyof typeof SUPPLIER_TEXT;
const SUPPLIER_KEYS = Object.keys(SUPPLIER_TEXT) as SupplierTextKey[];
// Left out on a first save, these get the service's built-in wording.
const CLAUSE_KEYS: ReadonlySet<string> = new Set([
  "reverseChargeCs",
  "reverseChargeEn",
  "advanceNoteCs",
  "advanceNoteEn",
]);

const supplierText = (key: SupplierTextKey) =>
  z
    .string()
    .max(SUPPLIER_TEXT[key])
    .describe(`${TEXTS.supplier.fields[key]}. ${T.supplier.field}`)
    .optional();

const supplierInput = z.strictObject({
  name: supplierText("name"),
  street: supplierText("street"),
  city: supplierText("city"),
  zip: supplierText("zip"),
  country: supplierText("country"),
  ico: supplierText("ico"),
  dic: supplierText("dic"),
  email: supplierText("email"),
  phone: supplierText("phone"),
  web: supplierText("web"),
  registryNote: supplierText("registryNote"),
  contactPerson: supplierText("contactPerson"),
  footerText: supplierText("footerText"),
  notVatPayerCs: supplierText("notVatPayerCs"),
  notVatPayerEn: supplierText("notVatPayerEn"),
  reverseChargeCs: supplierText("reverseChargeCs"),
  reverseChargeEn: supplierText("reverseChargeEn"),
  advanceNoteCs: supplierText("advanceNoteCs"),
  advanceNoteEn: supplierText("advanceNoteEn"),
  vatIdentified: z
    .boolean()
    .describe(`${TEXTS.supplier.fields.vatIdentified}. ${T.supplier.field}`)
    .optional(),
});

const supplierOutput = z.object({
  ...Object.fromEntries(SUPPLIER_KEYS.map((key) => [key, z.string()])),
  vatIdentified: z.boolean(),
  missing: z.array(z.string()),
}) as unknown as z.ZodType<SupplierOutput>;
type SupplierOutput = Record<SupplierTextKey, string> & {
  vatIdentified: boolean;
  missing: string[];
};

function supplierOf(ctx: ToolContext): SupplierOutput {
  const row = getSupplier(ctx.ownerId);
  const texts = Object.fromEntries(SUPPLIER_KEYS.map((key) => [key, row?.[key] ?? ""]));
  return {
    ...(texts as Record<SupplierTextKey, string>),
    vatIdentified: row?.vatIdentified ?? false,
    missing: missingSupplierFields(ctx.ownerId),
  };
}

// The supplier's own data, but printed on documents a customer may have suggested: fenced.
const supplierText_ = (headline?: string) => (o: SupplierOutput) =>
  [
    ...(headline ? [headline] : []),
    ...SUPPLIER_KEYS.filter((key) => o[key]).map((key) =>
      quoted(TEXTS.supplier.fields[key], o[key]),
    ),
    T.supplier.vatIdentified(o.vatIdentified),
    o.missing.length > 0 ? T.supplier.missing(o.missing.join(", ")) : T.supplier.complete,
  ].join("\n");

export const getSupplierTool = defineTool({
  name: T.supplier.get.name,
  title: T.supplier.get.title,
  description: T.supplier.get.description,
  level: "read",
  input: z.strictObject({}),
  output: supplierOutput,
  fieldLabels: TEXTS.supplier.fields,
  run: (ctx) => supplierOf(ctx),
  text: supplierText_(),
});

export const saveSupplierTool = defineTool({
  name: T.supplier.save.name,
  title: T.supplier.save.title,
  description: T.supplier.save.description,
  level: "accounting",
  input: supplierInput,
  output: supplierOutput,
  fieldLabels: TEXTS.supplier.fields,
  run: (ctx, args) => {
    // The web sends the whole form: what the assistant leaves out stays as stored.
    const row = getSupplier(ctx.ownerId);
    const values = Object.fromEntries(
      SUPPLIER_KEYS.map((key) => [
        key,
        args[key] ?? row?.[key] ?? (CLAUSE_KEYS.has(key) ? undefined : ""),
      ]),
    );
    saveSupplier(ctx.actor, {
      ...values,
      vatIdentified: args.vatIdentified ?? row?.vatIdentified ?? false,
    } as SupplierInput);
    return supplierOf(ctx);
  },
  text: supplierText_(T.supplier.save.done),
});

// ---------------------------------------------------------------------------------------------
// Preferences. The look of the document (design, colours, logo position) stays web-only.

const APPEARANCE = {
  designId: true,
  accentColor: true,
  surfaceColor: true,
  textColor: true,
  lineColor: true,
  logoPosition: true,
} as const;
// Amounts and rates come in as decimal text and are converted like the web form does (MCP-071).
const CONVERTED = {
  turnoverVatLimitMinor: true,
  turnoverFlatLimitMinor: true,
  fixedRates: true,
} as const;

const limitInput = z.string().max(30).nullable().describe(T.preferences.turnoverLimit).optional();

const preferencesInput = z.strictObject({
  ...preferencesPatchSchema.omit({ ...APPEARANCE, ...CONVERTED }).shape,
  turnoverVatLimit: limitInput,
  turnoverFlatLimit: limitInput,
  fixedRates: z
    .record(z.string().max(3), z.string().max(20))
    .describe(T.preferences.fixedRates)
    .optional(),
});

const preferencesOutput = preferencesSchema.omit({ ...APPEARANCE, ...CONVERTED }).extend({
  turnoverVatLimit: moneySchema.nullable(),
  turnoverFlatLimit: moneySchema.nullable(),
  fixedRates: z.record(z.string(), z.string()),
});
type PreferencesOutput = z.infer<typeof preferencesOutput>;

function limitOf(text: string | null | undefined): number | null | undefined {
  if (text === undefined || text === null) return text;
  const minor = parseMoney(text);
  if (minor === null || minor < 1) {
    throw new McpToolError(TEXTS.preferences.turnoverLimits.invalid);
  }
  return minor;
}

function ratesOf(rates: Record<string, string> | undefined): Record<string, number> | undefined {
  if (!rates) return undefined;
  const parsed: Record<string, number> = {};
  for (const [code, text] of Object.entries(rates)) {
    // An empty rate means the ČNB rate, as an empty field in the web form.
    if (!text.trim()) continue;
    const micros = parseRate(text);
    if (micros === null) throw new McpToolError(TEXTS.preferences.fixedRates.invalid(code));
    parsed[code] = micros;
  }
  return parsed;
}

function preferencesOf(ctx: ToolContext): PreferencesOutput {
  const prefs: Preferences = getPreferences(ctx.ownerId);
  const {
    designId: _designId,
    accentColor: _accent,
    surfaceColor: _surface,
    textColor: _text,
    lineColor: _line,
    logoPosition: _logo,
    turnoverVatLimitMinor,
    turnoverFlatLimitMinor,
    fixedRates,
    ...rest
  } = prefs;
  return {
    ...rest,
    turnoverVatLimit: turnoverVatLimitMinor === null ? null : money(turnoverVatLimitMinor, "CZK"),
    turnoverFlatLimit:
      turnoverFlatLimitMinor === null ? null : money(turnoverFlatLimitMinor, "CZK"),
    fixedRates: Object.fromEntries(
      Object.entries(fixedRates).map(([code, micros]) => [code, formatRate(micros)]),
    ),
  };
}

const PREFERENCE_LABELS: Record<string, string> = TEXTS.preferences.fields;

const preferencesText = (headline?: string) => (o: PreferencesOutput) =>
  [
    ...(headline ? [headline] : [T.preferences.heading]),
    ...Object.entries(o)
      .filter(([key]) => PREFERENCE_LABELS[key])
      .map(([key, value]) => {
        const label = PREFERENCE_LABELS[key]!;
        // Default texts are the user's own wording, printed on documents: fenced.
        return typeof value === "string"
          ? quoted(label, value)
          : T.preferences.row(label, String(value));
      }),
    T.preferences.row(
      TEXTS.preferences.fields.turnoverVatLimitMinor,
      o.turnoverVatLimit?.formatted ?? T.preferences.statutory,
    ),
    T.preferences.row(
      TEXTS.preferences.fields.turnoverFlatLimitMinor,
      o.turnoverFlatLimit?.formatted ?? T.preferences.statutory,
    ),
    ...Object.entries(o.fixedRates).map(([code, rate]) =>
      T.preferences.row(TEXTS.preferences.fixedRates.rate(code), rate),
    ),
  ].join("\n");

export const getPreferencesTool = defineTool({
  name: T.preferences.get.name,
  title: T.preferences.get.title,
  description: T.preferences.get.description,
  level: "read",
  input: z.strictObject({}),
  output: preferencesOutput,
  fieldLabels: TEXTS.preferences.fields,
  run: (ctx) => preferencesOf(ctx),
  text: preferencesText(),
});

export const savePreferencesTool = defineTool({
  name: T.preferences.save.name,
  title: T.preferences.save.title,
  description: T.preferences.save.description,
  level: "accounting",
  input: preferencesInput,
  output: preferencesOutput,
  fieldLabels: { ...TEXTS.preferences.fields, ...T.fields },
  run: (ctx, args) => {
    const { turnoverVatLimit, turnoverFlatLimit, fixedRates, ...rest } = args;
    const patch: PreferencesPatch = {
      ...rest,
      turnoverVatLimitMinor: limitOf(turnoverVatLimit),
      turnoverFlatLimitMinor: limitOf(turnoverFlatLimit),
      fixedRates: ratesOf(fixedRates),
    };
    // A key left undefined is not a change: the service merges the patch onto what is stored.
    for (const key of Object.keys(patch) as (keyof PreferencesPatch)[]) {
      if (patch[key] === undefined) delete patch[key];
    }
    savePreferences(ctx.actor, patch);
    return preferencesOf(ctx);
  },
  text: preferencesText(T.preferences.save.done),
});

// ---------------------------------------------------------------------------------------------
// Automation. Switching on and resuming need a person's confirmation, so they have no tool (5.7).

const A = T.automation;

const automationOutput = z.object({
  recurringSend: z.boolean(),
  reminders: z.boolean(),
  paymentReceipt: z.boolean(),
  advanceInvoice: z.boolean(),
  paused: z.boolean(),
  remindersOpenSince: z.string().nullable(),
  sendTime: z.string(),
  dailyDigest: z.boolean(),
  periodSummary: z.enum(PERIOD_SUMMARIES),
  taxReminder: z.boolean(),
  limitMail: z.boolean(),
});

const automationOf = (ctx: ToolContext): AutomationSettings => getAutomation(ctx.ownerId);

const flag = (on: boolean) => (on ? A.on : A.off);
const automationText = (headline?: string) => (o: AutomationSettings) =>
  [
    ...(headline ? [headline] : []),
    ...AUTOMATION_KEYS.map((key) => A.state(A.labels[key], flag(o[key]))),
    A.state(A.labels.paused, flag(o.paused)),
    A.state(A.labels.sendTime, o.sendTime),
    A.state(A.labels.dailyDigest, flag(o.dailyDigest)),
    A.state(A.labels.periodSummary, o.periodSummary),
    A.state(A.labels.taxReminder, flag(o.taxReminder)),
    A.state(A.labels.limitMail, flag(o.limitMail)),
  ].join("\n");

export const getAutomationTool = defineTool({
  name: A.get.name,
  title: A.get.title,
  description: A.get.description,
  level: "read",
  input: z.strictObject({}),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx) => automationOf(ctx),
  text: automationText(),
});

export const disableAutomationTool = defineTool({
  name: A.disable.name,
  title: A.disable.title,
  description: A.disable.description,
  level: "accounting",
  input: z.strictObject({ key: z.enum(AUTOMATION_KEYS).describe(A.key) }),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setAutomation(ctx.actor, args.key, false, { confirmed: false });
    return automationOf(ctx);
  },
  text: automationText(A.disable.done),
});

export const pauseAutomationTool = defineTool({
  name: A.pause.name,
  title: A.pause.title,
  description: A.pause.description,
  level: "accounting",
  input: z.strictObject({}),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx) => {
    setPaused(ctx.actor, true, { confirmed: false });
    return automationOf(ctx);
  },
  text: automationText(A.pause.done),
});

export const setSendTimeTool = defineTool({
  name: A.sendTime.name,
  title: A.sendTime.title,
  description: A.sendTime.description,
  level: "accounting",
  input: z.strictObject({ time: z.string().max(5).describe(A.time) }),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setSendTime(ctx.actor, args.time);
    return automationOf(ctx);
  },
  text: automationText(A.sendTime.done),
});

export const setDailyDigestTool = defineTool({
  name: A.dailyDigest.name,
  title: A.dailyDigest.title,
  description: A.dailyDigest.description,
  level: "accounting",
  input: z.strictObject({ enabled: z.boolean().describe(A.enabled) }),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setDailyDigest(ctx.actor, args.enabled);
    return automationOf(ctx);
  },
  text: automationText(A.dailyDigest.done),
});

export const setPeriodSummaryTool = defineTool({
  name: A.periodSummary.name,
  title: A.periodSummary.title,
  description: A.periodSummary.description,
  level: "accounting",
  input: z.strictObject({ mode: z.enum(PERIOD_SUMMARIES).describe(A.mode) }),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setPeriodSummary(ctx.actor, args.mode);
    return automationOf(ctx);
  },
  text: automationText(A.periodSummary.done),
});

export const setTaxReminderTool = defineTool({
  name: A.taxReminder.name,
  title: A.taxReminder.title,
  description: A.taxReminder.description,
  level: "accounting",
  input: z.strictObject({ enabled: z.boolean().describe(A.enabled) }),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setTaxReminder(ctx.actor, args.enabled);
    return automationOf(ctx);
  },
  text: automationText(A.taxReminder.done),
});

export const setLimitMailTool = defineTool({
  name: A.limitMail.name,
  title: A.limitMail.title,
  description: A.limitMail.description,
  level: "accounting",
  input: z.strictObject({ enabled: z.boolean().describe(A.enabled) }),
  output: automationOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    setLimitMail(ctx.actor, args.enabled);
    return automationOf(ctx);
  },
  text: automationText(A.limitMail.done),
});

// ---------------------------------------------------------------------------------------------
// Reminder rules.

const R = T.reminders;

const contentSchema = z.object({ subject: z.string(), body: z.string() });
const reminderTexts = z
  .object({ cs: contentSchema.optional(), en: contentSchema.optional() })
  .nullable();
const ruleOutput = z.object({
  id: z.string(),
  offsetDays: z.number().int(),
  activeSince: z.string(),
  texts: reminderTexts,
});

const ruleOf = (rule: ReminderRule) => ({
  id: rule.id,
  offsetDays: rule.offsetDays,
  activeSince: rule.activeSince,
  texts: rule.texts,
});

// Another account's rule is not seen here, as a missing one (MCP-074).
function ownRule(ctx: ToolContext, ruleId: string): ReminderRule {
  const rule = listReminderRules(ctx.ownerId).find((row) => row.id === ruleId);
  if (!rule) throw new McpToolError(TEXTS.reminders.errors.notFound);
  return rule;
}

const ruleText = (rule: z.infer<typeof ruleOutput>) =>
  [
    R.row(rule.id, rule.offsetDays, rule.texts !== null),
    ...(Object.entries(rule.texts ?? {}) as [string, { subject: string } | undefined][])
      .filter(([, content]) => content)
      .map(([language, content]) => quoted(R.subjectLabel(language), content!.subject)),
  ].join("\n");

export const listReminderRulesTool = defineTool({
  name: R.list.name,
  title: R.list.title,
  description: R.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ rules: z.array(ruleOutput) }),
  fieldLabels: T.fields,
  run: (ctx) => ({ rules: listReminderRules(ctx.ownerId).map(ruleOf) }),
  text: (o) => (o.rules.length === 0 ? R.empty : [R.heading, ...o.rules.map(ruleText)].join("\n")),
});

export const saveReminderRuleTool = defineTool({
  name: R.save.name,
  title: R.save.title,
  description: R.save.description,
  level: "accounting",
  input: z.strictObject({
    id: id(R.id).optional(),
    offsetDays: z.number().int().describe(R.offsetDays).optional(),
    texts: reminderTexts.describe(R.texts).optional(),
  }),
  output: ruleOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const stored = args.id ? ownRule(ctx, args.id) : null;
    const saved = saveReminderRule(ctx.actor, {
      id: args.id,
      offsetDays: args.offsetDays ?? stored?.offsetDays,
      texts: args.texts === undefined ? (stored?.texts ?? null) : args.texts,
    });
    return ruleOf(ownRule(ctx, saved.id));
  },
  text: (o) => [R.save.done, ruleText(o)].join("\n"),
});

export const deleteReminderRuleTool = defineTool({
  name: R.delete.name,
  title: R.delete.title,
  description: R.delete.description,
  level: "full",
  input: z.strictObject({ id: id(R.id) }),
  output: z.object({ id: z.string() }),
  fieldLabels: T.fields,
  run: (ctx, args) => {
    deleteReminderRule(ctx.actor, args.id);
    return { id: args.id };
  },
  text: () => R.delete.done,
});

// ---------------------------------------------------------------------------------------------
// E-mail templates.

const M = T.templates;

const which = {
  kind: z.enum(MESSAGE_KINDS).describe(M.kind),
  language: z.enum(LANGUAGES).describe(M.language),
};
const templateOutput = z.object({
  kind: z.string(),
  language: z.string(),
  subject: z.string(),
  body: z.string(),
  custom: z.boolean(),
});
type TemplateOutput = z.infer<typeof templateOutput>;

function templateOf(ctx: ToolContext, kind: string, language: string): TemplateOutput {
  const row = listEmailTemplates(ctx.ownerId).find(
    (item) => item.kind === kind && item.language === language,
  )!;
  return {
    kind: row.kind,
    language: row.language,
    subject: row.subject,
    body: row.body,
    custom: row.custom,
  };
}

const templateText = (headline?: string) => (o: TemplateOutput) =>
  [
    ...(headline ? [headline] : []),
    M.row(o.kind, o.language, o.custom ? M.custom : ""),
    quoted(M.subjectLabel, o.subject),
    quoted(M.bodyLabel, o.body),
  ].join("\n");

export const listEmailTemplatesTool = defineTool({
  name: M.list.name,
  title: M.list.title,
  description: M.list.description,
  level: "read",
  input: z.strictObject({}),
  output: z.object({ templates: z.array(templateOutput) }),
  fieldLabels: T.fields,
  run: (ctx) => ({
    templates: listEmailTemplates(ctx.ownerId).map((row) => ({
      kind: row.kind,
      language: row.language,
      subject: row.subject,
      body: row.body,
      custom: row.custom,
    })),
  }),
  text: (o) =>
    [
      M.heading,
      ...o.templates.map((row) =>
        [
          M.row(row.kind, row.language, row.custom ? M.custom : ""),
          quoted(M.subjectLabel, row.subject),
        ].join(": "),
      ),
    ].join("\n"),
});

export const getEmailTemplateTool = defineTool({
  name: M.get.name,
  title: M.get.title,
  description: M.get.description,
  level: "read",
  input: z.strictObject(which),
  output: templateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => templateOf(ctx, args.kind, args.language),
  text: templateText(),
});

export const saveEmailTemplateTool = defineTool({
  name: M.save.name,
  title: M.save.title,
  description: M.save.description,
  level: "accounting",
  input: z.strictObject({
    ...which,
    subject: z.string().max(1000).describe(M.subject).optional(),
    body: z.string().max(20_000).describe(M.body).optional(),
  }),
  output: templateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const current = getEmailTemplate(ctx.ownerId, args.kind, args.language);
    saveEmailTemplate(ctx.actor, {
      kind: args.kind,
      language: args.language,
      subject: args.subject ?? current.subject,
      body: args.body ?? current.body,
    });
    return templateOf(ctx, args.kind, args.language);
  },
  text: templateText(M.save.done),
});

export const resetEmailTemplateTool = defineTool({
  name: M.reset.name,
  title: M.reset.title,
  description: M.reset.description,
  level: "accounting",
  input: z.strictObject(which),
  output: templateOutput,
  fieldLabels: T.fields,
  run: (ctx, args) => {
    const { subject, body } = resetEmailTemplateAndRead(ctx.actor, args.kind, args.language);
    return { kind: args.kind, language: args.language, subject, body, custom: false };
  },
  text: templateText(M.reset.done),
});

export const SETTINGS_TOOLS = [
  getSupplierTool,
  saveSupplierTool,
  getPreferencesTool,
  savePreferencesTool,
  getAutomationTool,
  disableAutomationTool,
  pauseAutomationTool,
  setSendTimeTool,
  setDailyDigestTool,
  setPeriodSummaryTool,
  setTaxReminderTool,
  setLimitMailTool,
  listReminderRulesTool,
  saveReminderRuleTool,
  deleteReminderRuleTool,
  listEmailTemplatesTool,
  getEmailTemplateTool,
  saveEmailTemplateTool,
  resetEmailTemplateTool,
];
