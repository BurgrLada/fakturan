import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

// The control sits inside its label: a route hidden by Next keeps its ids in the DOM, and the same
// list with another query is a separate hidden route.
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="flex-col items-stretch gap-1">
      {label}
      {children}
    </Label>
  );
}
