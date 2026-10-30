import { Suspense } from "react";
import { SettingsTabs, SettingsTabsView } from "@/components/settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={<SettingsTabsView pathname={null} />}>
        <SettingsTabs />
      </Suspense>
      {children}
    </>
  );
}
