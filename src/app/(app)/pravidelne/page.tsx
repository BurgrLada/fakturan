import { PlannedSection, plannedMetadata } from "@/components/planned-section";

export const metadata = plannedMetadata("recurring");

export default function Page() {
  return <PlannedSection navKey="recurring" />;
}
