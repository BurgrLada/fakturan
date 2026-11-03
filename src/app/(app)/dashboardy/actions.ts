"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import type { LayoutItem } from "@/lib/dashboard-layout";
import { calendarDateInPrague } from "@/lib/number-format";
import { TEXTS } from "@/lib/texts";
import { accountTag } from "@/server/account-cache";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { clock } from "@/server/clock";
import type { WidgetResult } from "@/server/reports/widget-query";
import { ServiceError } from "@/server/services/access";
import {
  createDashboard,
  deleteDashboard,
  duplicateDashboard,
  importDashboard,
  ownerOf,
  previewImport,
  renameDashboard,
  saveLayout,
  setDefaultDashboard,
  type ImportPreview,
} from "@/server/services/dashboards";
import { addWidget, previewWidget, removeWidget, updateWidget } from "@/server/services/widgets";

const E = TEXTS.dashboard.errors;

type Failure = { ok: false; error: string; expired?: true };
type Reply<Output extends object = object> = ({ ok: true } & Output) | Failure;
type Actor = Awaited<ReturnType<typeof actorFromRequest>>;

const previewInput = z.strictObject({ config: z.unknown() }, E.invalid);
const fileInput = z.strictObject({ text: z.string() }, E.invalid);

function fileText(raw: unknown): string {
  const parsed = fileInput.safeParse(raw);
  if (!parsed.success) throw new ServiceError(E.invalid);
  return parsed.data.text;
}

// The services validate their own input with Czech paths, so only the session is checked here.
// An expired session is reported instead of redirected, so the editor keeps unsaved changes.
async function run<Output extends object = object>(
  raw: unknown,
  work: (raw: unknown, actor: Actor) => Output | void,
): Promise<Reply<Output>> {
  if (!(await getCurrentSession())) return { ok: false, expired: true, error: E.signedOut };
  try {
    const actor = await actorFromRequest();
    const output = work(raw, actor);
    return { ok: true, ...(output as Output) };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

function write<Output extends object = object>(
  raw: unknown,
  work: (raw: unknown, actor: Actor) => Output | void,
): Promise<Reply<Output>> {
  return run(raw, (input, actor) => {
    const output = work(input, actor);
    updateTag(accountTag(ownerOf(actor)));
    revalidatePath("/");
    return output;
  });
}

export async function createDashboardAction(raw: unknown): Promise<Reply<{ id: string }>> {
  return write(raw, (input, actor) => createDashboard(actor, input));
}

export async function renameDashboardAction(raw: unknown): Promise<Reply> {
  return write(raw, (input, actor) => renameDashboard(actor, input));
}

export async function duplicateDashboardAction(raw: unknown): Promise<Reply<{ id: string }>> {
  return write(raw, (input, actor) => duplicateDashboard(actor, input));
}

export async function deleteDashboardAction(raw: unknown): Promise<Reply> {
  return write(raw, (input, actor) => deleteDashboard(actor, input));
}

export async function setDefaultDashboardAction(raw: unknown): Promise<Reply> {
  return write(raw, (input, actor) => setDefaultDashboard(actor, input));
}

export async function saveLayoutAction(
  raw: unknown,
): Promise<Reply<{ revision: number; items: LayoutItem[] }>> {
  return write(raw, (input, actor) => saveLayout(actor, input));
}

export async function addWidgetAction(raw: unknown): Promise<Reply<{ id: string }>> {
  return write(raw, (input, actor) => addWidget(actor, input));
}

export async function updateWidgetAction(raw: unknown): Promise<Reply> {
  return write(raw, (input, actor) => updateWidget(actor, input));
}

export async function removeWidgetAction(raw: unknown): Promise<Reply> {
  return write(raw, (input, actor) => removeWidget(actor, input));
}

// DSH-017: no cache and its own rate limit; the owner comes from the session, never the input.
export async function previewWidgetAction(raw: unknown): Promise<Reply<{ result: WidgetResult }>> {
  return run(raw, (input, actor) => {
    const parsed = previewInput.safeParse(input);
    if (!parsed.success) throw new ServiceError(E.invalid);
    const today = calendarDateInPrague(clock.now());
    return { result: previewWidget(actor, parsed.data.config, { today }) };
  });
}

// DSH-032: the preview writes nothing; the import checks the same text again on its own.
export async function previewImportAction(
  raw: unknown,
): Promise<Reply<{ preview: ImportPreview }>> {
  return run(raw, (input, actor) => ({ preview: previewImport(actor, fileText(input)) }));
}

export async function importDashboardAction(raw: unknown): Promise<Reply<{ id: string }>> {
  return write(raw, (input, actor) => importDashboard(actor, fileText(input)));
}
