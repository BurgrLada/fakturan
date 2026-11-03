"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  createDashboardAction,
  deleteDashboardAction,
  duplicateDashboardAction,
  renameDashboardAction,
  setDefaultDashboardAction,
} from "@/app/(app)/dashboardy/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mayLeave } from "@/lib/leave-guard";
import { TEXTS } from "@/lib/texts";

const T = TEXTS.dashboard.manage;
const X = TEXTS.dashboard.edit;

type Reply = { ok: true; id?: string } | { ok: false; error: string; expired?: true };
type Dialog = "create" | "rename" | "delete" | null;

const editorHref = (id: string) => `/dashboardy/${id}/upravit`;

function NameDialog({
  open,
  title,
  body,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  body?: string;
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(name);
  }
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {body && <AlertDialogDescription>{body}</AlertDialogDescription>}
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="dashboard-name">{T.name}</Label>
            <Input
              id="dashboard-name"
              value={name}
              maxLength={60}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <Button type="submit">{T.confirm}</Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// DSH-002: every dashboard action of the editor; leaving the page asks first when the layout is
// not saved.
export function DashboardDialogs({
  dashboard,
  count,
}: {
  dashboard: { id: string; name: string; isDefault: boolean };
  count: number;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // An action that leaves the page asks first, so a refusal writes nothing.
  function act(
    work: () => Promise<Reply>,
    done: (reply: Reply & { ok: true }) => Promise<void>,
    leaves = false,
  ) {
    setDialog(null);
    setMessage(null);
    startTransition(async () => {
      if (leaves && !(await mayLeave())) return;
      try {
        const reply = await work();
        if (!reply.ok) {
          setMessage({ ok: false, text: reply.expired ? X.expired : reply.error });
          return;
        }
        await done(reply);
      } catch {
        setMessage({ ok: false, text: T.failed });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={T.label} className="flex flex-wrap items-center gap-2">
        {dashboard.isDefault ? (
          <Badge variant="secondary">{T.isDefault}</Badge>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              act(
                () => setDefaultDashboardAction({ id: dashboard.id }),
                async () => setMessage({ ok: true, text: T.defaulted }),
              )
            }
          >
            {T.setDefault}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setDialog("rename")}
        >
          {T.rename}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() =>
            act(
              () => duplicateDashboardAction({ id: dashboard.id }),
              async (reply) => router.push(editorHref(reply.id!)),
              true,
            )
          }
        >
          {T.duplicate}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setDialog("create")}
        >
          {T.create}
        </Button>
        {count > 1 && (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => setDialog("delete")}
          >
            {T.delete}
          </Button>
        )}
      </div>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      )}
      <NameDialog
        key={`rename-${dialog === "rename"}`}
        open={dialog === "rename"}
        title={T.renameTitle}
        initial={dashboard.name}
        onClose={() => setDialog(null)}
        onSubmit={(name) =>
          act(
            () => renameDashboardAction({ id: dashboard.id, name }),
            async () => setMessage({ ok: true, text: T.renamed }),
          )
        }
      />
      <NameDialog
        key={`create-${dialog === "create"}`}
        open={dialog === "create"}
        title={T.createTitle}
        body={T.createBody}
        initial=""
        onClose={() => setDialog(null)}
        onSubmit={(name) =>
          act(
            () => createDashboardAction({ name }),
            async (reply) => router.push(editorHref(reply.id!)),
            true,
          )
        }
      />
      <AlertDialog open={dialog === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T.deleteTitle(dashboard.name)}</AlertDialogTitle>
            <AlertDialogDescription>{T.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() =>
                act(
                  () => deleteDashboardAction({ id: dashboard.id }),
                  async () => router.push("/"),
                )
              }
            >
              {T.delete}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
