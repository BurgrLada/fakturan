import Link from "next/link";
import { cn } from "@/lib/utils";

export function GoToLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-sm font-medium whitespace-nowrap text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
    >
      {children} →
    </Link>
  );
}
