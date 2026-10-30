import { PlannedSection, plannedMetadata } from "@/components/planned-section";

export const metadata = plannedMetadata("payments");

export default function Page() {
  return <PlannedSection navKey="payments" />;
}
