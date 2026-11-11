import { connection } from "next/server";
import { Suspense } from "react";
import { SettingsTabs, SettingsTabsView } from "@/components/settings-tabs";
import { env } from "@/server/env";
import { isMcpAvailable } from "@/server/mcp/availability";

// The environment is read per request, so the layout itself stays prerenderable.
async function Tabs() {
  await connection();
  return <SettingsTabs mcpAvailable={isMcpAvailable(env)} />;
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<SettingsTabsView pathname={null} mcpAvailable={false} />}>
        <Tabs />
      </Suspense>
      {children}
    </>
  );
}
