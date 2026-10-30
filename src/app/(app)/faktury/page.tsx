import Link from "next/link";
import { PlannedSection, plannedMetadata } from "@/components/planned-section";
import { buttonVariants } from "@/components/ui/button";
import { TEXTS } from "@/lib/texts";

export const metadata = plannedMetadata("invoices");

export default function Page() {
  return (
    <>
      <PlannedSection navKey="invoices" />
      <div>
        <Link href="/faktury/nova" className={buttonVariants()}>
          {TEXTS.invoices.add}
        </Link>
      </div>
    </>
  );
}
