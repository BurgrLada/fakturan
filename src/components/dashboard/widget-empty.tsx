import Link from "next/link";

// Every empty card says why and offers the next step (UI-009).
export function WidgetEmpty({
  text,
  action,
}: {
  text: string;
  action?: { href: string; label: string };
}) {
  return (
    <div data-testid="widget-empty" className="flex flex-1 flex-col items-start gap-2 text-sm">
      <p className="text-muted-foreground">{text}</p>
      {action && (
        <Link href={action.href} className="underline underline-offset-4">
          {action.label}
        </Link>
      )}
    </div>
  );
}
