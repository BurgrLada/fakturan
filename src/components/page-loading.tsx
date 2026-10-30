import { TEXTS } from "@/lib/texts";

export function PageLoading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {TEXTS.loading}
    </p>
  );
}
