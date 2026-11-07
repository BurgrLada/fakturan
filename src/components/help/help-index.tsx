import Link from "next/link";
import { TEXTS } from "@/lib/texts";

const H = TEXTS.help;

export function HelpIndex() {
  return (
    <>
      <nav aria-label={H.contents} className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">{H.contents}</h2>
        <ol className="grid list-decimal gap-1 pl-5 text-sm sm:grid-cols-2">
          {H.chapters.map((chapter) => (
            <li key={chapter.id}>
              <a
                href={`#${chapter.id}`}
                className="underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                {chapter.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {H.chapters.map((chapter) => (
        <section
          key={chapter.id}
          id={chapter.id}
          aria-labelledby={`${chapter.id}-title`}
          className="flex scroll-mt-6 flex-col gap-3"
        >
          <h2 id={`${chapter.id}-title`} className="font-brand text-xl">
            {chapter.title}
          </h2>
          {chapter.body.map((paragraph) =>
            paragraph === TEXTS.tax.disclaimer ? (
              <p
                key={paragraph}
                className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
              >
                {paragraph}
              </p>
            ) : (
              <p key={paragraph} className="max-w-prose text-sm leading-relaxed">
                {paragraph}
              </p>
            ),
          )}
          {chapter.links.length > 0 && (
            <nav aria-label={`${H.links}: ${chapter.title}`}>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {chapter.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </section>
      ))}
    </>
  );
}
