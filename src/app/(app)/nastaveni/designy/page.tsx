import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { DesignPicker } from "@/components/settings/design-picker";
import { TEXTS } from "@/lib/texts";
import { requireSession } from "@/server/auth/session";
import { DESIGNS } from "@/server/pdf/designs";
import { getPreferences } from "@/server/services/preferences";

export const metadata: Metadata = { title: `${TEXTS.designs.title} | ${TEXTS.appName}` };

async function DesignsContent() {
  const { user } = await requireSession();
  const { designId, accentColor, surfaceColor, textColor, lineColor, logoPosition } =
    getPreferences(user.id);
  return (
    <DesignPicker
      designs={DESIGNS.map(({ id, name, tokens }) => ({ id, name, colors: tokens.colors }))}
      initial={{ designId, accentColor, surfaceColor, textColor, lineColor, logoPosition }}
    />
  );
}

export default function DesignsPage() {
  return (
    <>
      <h1 className="font-brand text-2xl">{TEXTS.designs.title}</h1>
      <p className="text-sm text-muted-foreground">{TEXTS.designs.intro}</p>
      <Suspense fallback={<PageLoading />}>
        <DesignsContent />
      </Suspense>
    </>
  );
}
