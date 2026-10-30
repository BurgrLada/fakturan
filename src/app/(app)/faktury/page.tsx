import { PlannedSection, plannedMetadata } from "@/components/planned-section";

export const metadata = plannedMetadata("invoices");

export default function Page() {
  return <PlannedSection navKey="invoices" />;
}
