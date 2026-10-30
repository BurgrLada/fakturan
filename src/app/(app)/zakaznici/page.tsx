import { PlannedSection, plannedMetadata } from "@/components/planned-section";

export const metadata = plannedMetadata("customers");

export default function Page() {
  return <PlannedSection navKey="customers" />;
}
