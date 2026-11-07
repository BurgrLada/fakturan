import { ChevronDown } from "lucide-react";
import { TEXTS } from "@/lib/texts";

const H = TEXTS.help;

// Native details/summary: Enter and Space toggle an answer without any script.
export function HelpFaq() {
  return (
    <section id="caste-otazky" aria-labelledby="caste-otazky-title" className="flex flex-col gap-3">
      <h2 id="caste-otazky-title" className="font-brand text-xl">
        {H.faqTitle}
      </h2>
      <div className="divide-y rounded-lg border">
        {H.faq.map((item) => (
          <details key={item.q} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
              <span>{item.q}</span>
              <ChevronDown
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="max-w-prose px-4 pb-3 text-sm leading-relaxed text-muted-foreground">
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
