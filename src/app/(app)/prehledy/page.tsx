import { PlannedSection, plannedMetadata } from "@/components/planned-section";

export const metadata = plannedMetadata("reports");

export default function Page() {
  return <PlannedSection navKey="reports" />;
}
