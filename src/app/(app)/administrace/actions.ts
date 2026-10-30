"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actorFromRequest, requireAdmin } from "@/server/auth/session";
import { ServiceError } from "@/server/services/access";
import {
  createInvitation,
  resendInvitation,
  revokeInvitation,
  type InvitationLink,
} from "@/server/services/invitations";
import { deactivateUser, deleteUser, reactivateUser, setRole } from "@/server/services/users";

type Failure = { ok: false; error: string };
type Done = { ok: true } | Failure;
type LinkResult = ({ ok: true } & InvitationLink) | Failure;

const id = z.string().min(1).max(128);
const userInput = z.object({ userId: id });
const invitationInput = z.object({ id });
const emailInput = z.object({ email: z.email().max(254) });
const roleInput = z.object({ userId: id, role: z.enum(["admin", "user"]) });
const deleteInput = z.object({ userId: id, confirmEmail: z.string().min(1).max(254) });

// Only known refusals become messages: requireAdmin's 404 and redirect must keep propagating.
async function run<Input, Output extends object>(
  schema: z.ZodType<Input>,
  raw: unknown,
  work: (
    input: Input,
    actor: Awaited<ReturnType<typeof actorFromRequest>>,
  ) => Output | Promise<Output>,
): Promise<({ ok: true } & Output) | Failure> {
  await requireAdmin();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Neplatné údaje" };
  try {
    const output = await work(parsed.data, await actorFromRequest());
    revalidatePath("/administrace");
    return { ok: true, ...output };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function createInvitationAction(raw: unknown): Promise<LinkResult> {
  return run(emailInput, raw, ({ email }, actor) => createInvitation(actor, email));
}

export async function resendInvitationAction(raw: unknown): Promise<LinkResult> {
  return run(invitationInput, raw, (input, actor) => resendInvitation(actor, input.id));
}

export async function revokeInvitationAction(raw: unknown): Promise<Done> {
  return run(invitationInput, raw, (input, actor) => {
    revokeInvitation(actor, input.id);
    return {};
  });
}

export async function setRoleAction(raw: unknown): Promise<Done> {
  return run(roleInput, raw, ({ userId, role }, actor) => {
    setRole(actor, userId, role);
    return {};
  });
}

export async function deactivateUserAction(raw: unknown): Promise<Done> {
  return run(userInput, raw, ({ userId }, actor) => {
    deactivateUser(actor, userId);
    return {};
  });
}

export async function reactivateUserAction(raw: unknown): Promise<Done> {
  return run(userInput, raw, ({ userId }, actor) => {
    reactivateUser(actor, userId);
    return {};
  });
}

export async function deleteUserAction(raw: unknown): Promise<Done> {
  return run(deleteInput, raw, ({ userId, confirmEmail }, actor) => {
    deleteUser(actor, userId, confirmEmail);
    return {};
  });
}
