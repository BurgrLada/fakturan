import { PlannedSection, plannedMetadata } from "@/components/planned-section";

export const metadata = plannedMetadata("catalog");

export default function Page() {
  return <PlannedSection navKey="catalog" />;
}
