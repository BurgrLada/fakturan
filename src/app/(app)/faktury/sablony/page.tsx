import { LayoutTemplate } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { TemplateList } from "@/components/invoices/template-list";
import { PageLoading } from "@/components/page-loading";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { listTemplates } from "@/server/services/invoice-templates";

const T = TEXTS.invoices.templates;

export const metadata: Metadata = { title: `${T.title} | ${TEXTS.appName}` };

async function TemplatesContent() {
  const { user } = await requireSession();
  const rows = listTemplates(user.id);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={LayoutTemplate}
        title={T.empty}
        description={T.emptyBody}
        action={
          <Link href="/faktury" className={buttonVariants({ variant: "outline" })}>
            {T.back}
          </Link>
        }
      />
    );
  }
  return (
    <TemplateList
      rows={rows.map((row) => ({
        id: row.id,
        name: row.name,
        customerName: row.customerName,
        lineCount: row.document.lines.length,
        updatedAt: row.updatedAt,
      }))}
    />
  );
}

export default function TemplatesPage() {
  return (
    <>
      <Link
        href="/faktury"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "self-start" })}
      >
        {T.back}
      </Link>
      <h1 className="font-brand text-2xl">{T.title}</h1>
      <p className="text-sm text-muted-foreground">{T.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <TemplatesContent />
      </Suspense>
    </>
  );
}
