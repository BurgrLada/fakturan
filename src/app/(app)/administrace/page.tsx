import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { z } from "zod";
import { InstanceStatus } from "@/components/admin/instance-status";
import { InvitationsPanel } from "@/components/admin/invitations-panel";
import { UsersTable } from "@/components/admin/users-table";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { auditActionLabel } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format";
import { actorFromRequest, requireAdmin } from "@/server/auth/session";
import { getInstanceStatus } from "@/server/services/instance-status";
import { listInstanceAudit } from "@/server/services/instance-audit";
import { listInvitations } from "@/server/services/invitations";
import { listUsers } from "@/server/services/users";

export const metadata: Metadata = { title: "Administrace | Fakturan" };

const pageParam = z.coerce.number().int().min(1).catch(1);

function eventsPage(page: number): string {
  return `/administrace?strana=${page}`;
}

function InstanceEvents({ events }: { events: ReturnType<typeof listInstanceAudit> }) {
  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Čas</TableHead>
            <TableHead>Událost</TableHead>
            <TableHead>Kdo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{formatDateTime(row.at)}</TableCell>
              <TableCell>{auditActionLabel(row.action)}</TableCell>
              <TableCell>{row.actorEmail ?? "–"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex gap-2">
        {events.page > 1 && (
          <Button
            variant="outline"
            render={<Link href={eventsPage(events.page - 1)} />}
            nativeButton={false}
          >
            Novější
          </Button>
        )}
        {events.hasNext && (
          <Button
            variant="outline"
            render={<Link href={eventsPage(events.page + 1)} />}
            nativeButton={false}
          >
            Starší
          </Button>
        )}
      </div>
    </div>
  );
}

async function AdminContent({ searchParams }: Pick<PageProps<"/administrace">, "searchParams">) {
  const session = await requireAdmin();
  const { strana } = await searchParams;
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
    <Tabs defaultValue={strana === undefined ? "uzivatele" : "udalosti"}>
      <TabsList>
        <TabsTrigger value="uzivatele">Uživatelé</TabsTrigger>
        <TabsTrigger value="pozvanky">Pozvánky</TabsTrigger>
        <TabsTrigger value="udalosti">Události instance</TabsTrigger>
        <TabsTrigger value="stav">Stav instance</TabsTrigger>
      </TabsList>
      <TabsContent value="uzivatele">
        <UsersTable users={users} currentUserId={session.user.id} />
      </TabsContent>
      <TabsContent value="pozvanky">
        <InvitationsPanel invitations={invitations} />
      </TabsContent>
      <TabsContent value="udalosti">
        <InstanceEvents events={listInstanceAudit(actor, { page: pageParam.parse(strana) })} />
      </TabsContent>
      <TabsContent value="stav">
        <InstanceStatus status={getInstanceStatus(actor)} />
      </TabsContent>
    </Tabs>
  );
}

export default function AdminPage({ searchParams }: PageProps<"/administrace">) {
  return (
    <>
      <h1 className="font-brand text-2xl">Administrace</h1>
      <Suspense fallback={<PageLoading />}>
        <AdminContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
