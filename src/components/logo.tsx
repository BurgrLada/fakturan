import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/brand/logo.svg"
        alt="Fakturan"
        width={323}
        height={74}
        className={cn("h-auto w-40 dark:hidden", className)}
      />
      <img
        src="/brand/logo-dark.svg"
        alt="Fakturan"
        width={323}
        height={74}
        className={cn("hidden h-auto w-40 dark:block", className)}
      />
    </>
  );
}
