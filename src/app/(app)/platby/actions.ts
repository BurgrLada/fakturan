"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assignInputSchema, splitInputSchema } from "@/lib/notice-queue";
import { TEXTS } from "@/lib/texts";
import { actorFromRequest, getCurrentSession } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import { ownerOf } from "@/server/services/invoices";
import { checkMailboxNow } from "@/server/services/bank-poll";
import {
  assignNotice,
  dismissNotice,
  noticeCandidates,
  restoreNotice,
  splitNotice,
  undoNotice,
} from "@/server/services/bank-notices";

const E = TEXTS.bankQueue.errors;

type Failure = { ok: false; error: string; expired?: true };
type Reply = { ok: true } | Failure;
type Actor = Awaited<ReturnType<typeof actorFromRequest>>;

const id = z.string(E.invalid).min(1, E.invalid);
const idInput = z.object({ id }, E.invalid);
const assignInput = z.object({ id, assign: assignInputSchema }, E.invalid);
const splitInput = z.object({ id, split: splitInputSchema }, E.invalid);
const checkInput = z.object({ requestId: z.uuid(E.invalid) }, E.invalid);

// An expired session is reported instead of redirected, so the open dialog keeps what was typed.
async function run<Input, Output extends object = object>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (input: Input, actor: Actor) => Output | void,
): Promise<({ ok: true } & Output) | Failure> {
  if (!(await getCurrentSession())) return { ok: false, expired: true, error: E.expired };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? E.invalid };
  try {
    const output = work(parsed.data, await actorFromRequest());
    return { ok: true, ...(output as Output) };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

function changed() {
  revalidatePath("/", "layout");
}

export async function assignNoticeAction(raw: unknown): Promise<Reply> {
  return run(assignInput, raw, ({ id: noticeId, assign }, actor) => {
    assignNotice(actor, noticeId, assign);
    changed();
  });
}

export async function splitNoticeAction(raw: unknown): Promise<Reply> {
  return run(splitInput, raw, ({ id: noticeId, split }, actor) => {
    splitNotice(actor, noticeId, split);
    changed();
  });
}

export async function dismissNoticeAction(raw: unknown): Promise<Reply> {
  return run(idInput, raw, ({ id: noticeId }, actor) => {
    dismissNotice(actor, noticeId);
    changed();
  });
}

export async function restoreNoticeAction(raw: unknown): Promise<Reply> {
  return run(idInput, raw, ({ id: noticeId }, actor) => {
    restoreNotice(actor, noticeId);
    changed();
  });
}

export async function undoNoticeAction(raw: unknown): Promise<Reply> {
  return run(idInput, raw, ({ id: noticeId }, actor) => {
    undoNotice(actor, noticeId);
    changed();
  });
}

export async function noticeCandidatesAction(raw: unknown) {
  return run(idInput, raw, ({ id: noticeId }, actor) => ({
    candidates: noticeCandidates(ownerOf(actor), noticeId),
  }));
}

export async function checkMailboxNowAction(raw: unknown): Promise<Reply> {
  return run(checkInput, raw, ({ requestId }, actor) => {
    checkMailboxNow(actor, requestId);
    revalidatePath("/platby");
  });
}
