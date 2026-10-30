import type { Metadata } from "next";
import { Suspense } from "react";
import { InvitationsPanel } from "@/components/admin/invitations-panel";
import { UsersTable } from "@/components/admin/users-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";
import { actorFromRequest, requireAdmin } from "@/server/auth/session";
import { listInstanceAudit } from "@/server/services/instance-audit";
import { listInvitations } from "@/server/services/invitations";
import { listUsers } from "@/server/services/users";

export const metadata: Metadata = { title: "Administrace | Fakturan" };

const ACTION_LABELS: Record<string, string> = {
  "access.denied": "Odmítnutý přístup",
  "auth.login": "Přihlášení",
  "auth.login_failed": "Neúspěšné přihlášení",
  "auth.logout": "Odhlášení",
  "invitation.accept": "Přijetí pozvánky",
  "invitation.create": "Nová pozvánka",
  "invitation.resend": "Nové odeslání pozvánky",
  "invitation.revoke": "Zrušení pozvánky",
  "rate_limit.exceeded": "Překročený limit",
  "user.create": "Nový účet",
  "user.deactivate": "Deaktivace účtu",
  "user.delete": "Smazání účtu",
  "user.reactivate": "Reaktivace účtu",
  "user.role_change": "Změna role",
};

function InstanceEvents({ rows }: { rows: ReturnType<typeof listInstanceAudit> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Čas</TableHead>
          <TableHead>Událost</TableHead>
          <TableHead>Kdo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{formatDateTime(row.at)}</TableCell>
            <TableCell>{ACTION_LABELS[row.action] ?? row.action}</TableCell>
            <TableCell>{row.actorEmail ?? "–"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

async function AdminContent() {
  const session = await requireAdmin();
  const actor = await actorFromRequest();
  const users = listUsers(actor).map((row) => ({
    ...row,
    createdAt: formatDateTime(row.createdAt),
    lastLoginAt: formatDateTime(row.lastLoginAt),
  }));
  const invitations = listInvitations(actor).map((row) => ({
    id: row.id,
    email: row.email,
    expired: row.expired,
    expiresAt: formatDateTime(row.expiresAt),
  }));
  return (
    <Tabs defaultValue="uzivatele">
      <TabsList>
        <TabsTrigger value="uzivatele">Uživatelé</TabsTrigger>
        <TabsTrigger value="pozvanky">Pozvánky</TabsTrigger>
        <TabsTrigger value="udalosti">Události instance</TabsTrigger>
      </TabsList>
      <TabsContent value="uzivatele">
        <UsersTable users={users} currentUserId={session.user.id} />
      </TabsContent>
      <TabsContent value="pozvanky">
        <InvitationsPanel invitations={invitations} />
      </TabsContent>
      <TabsContent value="udalosti">
        <InstanceEvents rows={listInstanceAudit(actor)} />
      </TabsContent>
    </Tabs>
  );
}

export default function AdminPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">Administrace</h1>
      <Suspense>
        <AdminContent />
      </Suspense>
    </>
  );
}
